/**
 * Dump data game dari package `genshin-db` (devDependency) ke JSON statis:
 *   backend/scrape-data/Talents/<Key>.json    multiplier talent + teks passive/constellation
 *   backend/scrape-data/Weapons/<slug>.json   base ATK + efek pasif per refinement
 *   backend/scrape-data/Artifacts/<slug>.json teks 2pc/4pc
 *
 *   node scripts/dump-genshin-db.mjs [--only HuTao,RaidenShogun]
 *
 * Jalan SEKALI (atau tiap patch baru), output di-commit. Runtime backend cuma baca JSON
 * ini lewat gameDataStore — nggak butuh genshin-db.
 * `attributes` talent disimpan VERBATIM (labels + parameters); parsing ke hit dilakukan
 * di TS (lib/talentLabel.ts) biar fix parser nggak perlu re-dump.
 */
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const gdb = require("genshin-db");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_DIR = process.env.ENKA_STORE_CACHE_DIR ?? path.join(ROOT, ".cache/enka");
const OUT = path.join(ROOT, "scrape-data");
const OUT_TALENTS = path.join(OUT, "Talents");
const OUT_WEAPONS = path.join(OUT, "Weapons");
const OUT_ARTIFACTS = path.join(OUT, "Artifacts");

// sama persis dengan src/lib/characterKey.ts (nggak bisa import TS dari .mjs)
const deriveKey = (name) => name.replace(/[^A-Za-z0-9]/g, "");
const slugify = (name) =>
  name
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
const ELEMENT_MAP = {
  Fire: "Pyro",
  Water: "Hydro",
  Grass: "Dendro",
  Electric: "Electro",
  Wind: "Anemo",
  Rock: "Geo",
  Ice: "Cryo",
};

/** nameEn Enka -> nama/alias genshin-db, cuma buat yang matching otomatis gagal */
const GDB_ALIAS = {};

function parseArgs() {
  const only = new Set();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--only") argv[++i]?.split(",").forEach((k) => only.add(k.trim()));
  }
  return { only };
}

const WEAPON_TEXT_TO_ENKA = {
  Sword: "WEAPON_SWORD_ONE_HAND",
  Claymore: "WEAPON_CLAYMORE",
  Polearm: "WEAPON_POLE",
  Bow: "WEAPON_BOW",
  Catalyst: "WEAPON_CATALYST",
};

async function loadEnkaCharacters() {
  const chars = JSON.parse(await fs.readFile(path.join(CACHE_DIR, "characters.json"), "utf8"));
  const loc = JSON.parse(await fs.readFile(path.join(CACHE_DIR, "loc.json"), "utf8"));
  const en = loc.en ?? {};
  const out = [];
  const seen = new Set();
  const seenIds = new Set();
  for (const [rawKey, entry] of Object.entries(chars)) {
    const avatarId = Number.parseInt(rawKey, 10);
    if (!Number.isFinite(avatarId) || avatarId === 10000005 || avatarId === 10000007) continue;
    seenIds.add(avatarId);
    const nameEn = en[String(entry.NameTextMapHash ?? "")];
    if (!nameEn) continue;
    const key = deriveKey(nameEn);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      nameEn,
      element: ELEMENT_MAP[entry.Element] ?? entry.Element ?? null,
      weaponType: entry.WeaponType ?? null,
    });
  }
  return { list: out, seenIds, seenKeys: seen };
}

/**
 * Karakter yang ada di genshin-db tapi BELUM ada di store GitHub Enka (repo docs-nya sering
 * ketinggalan beberapa patch). Ditulis ke scrape-data/enka-store-extra.json dan dipakai
 * characterStore sebagai fallback mapping avatarId -> nama.
 */
function extraCharactersFromGdb(seenIds, seenKeys) {
  const out = [];
  for (const n of gdb.characters("names", { matchCategories: true }) ?? []) {
    const c = gdb.characters(n);
    if (!c?.id || seenIds.has(c.id)) continue;
    if (/traveler|aether|lumine/i.test(c.name)) continue;
    const key = deriveKey(c.name);
    // key sudah dipakai avatarId lain di store Enka (mis. "Columbina" 10000904 entri uji) → tetap tulis;
    // characterStore ganti entri lama dengan id genshin-db (yang beneran playable)
    const replaces = seenKeys.has(key);
    out.push({
      ...(replaces ? { replacesKey: true } : {}),
      avatarId: c.id,
      key,
      nameEn: c.name,
      element: c.elementText ?? null,
      weaponType: WEAPON_TEXT_TO_ENKA[c.weaponText] ?? null,
      rarity: c.rarity ?? 5,
      version: c.version ?? null,
    });
  }
  return out.sort((a, b) => a.avatarId - b.avatarId);
}

function pickTalent(t) {
  if (!t) return null;
  return {
    name: t.name,
    description: t.description ?? "",
    attributes: t.attributes
      ? { labels: t.attributes.labels ?? [], parameters: t.attributes.parameters ?? {} }
      : { labels: [], parameters: {} },
  };
}

function passiveSlot(i) {
  // genshin-db: passive1 = A1, passive2 = A4, passive3 = utility (exploration/cooking), passive4+ = lainnya
  return i === 1 ? "a1" : i === 2 ? "a4" : i === 3 ? "util" : "other";
}

/** { avatarId, key, nameEn, element, note } — store Enka yang salah, dikoreksi dari genshin-db */
const OVERRIDES = [];

function dumpCharacter(c) {
  const name = GDB_ALIAS[c.nameEn] ?? c.nameEn;
  const info = gdb.characters(name, { matchAliases: true });
  if (!info) return { error: "not_found" };
  // guard: fuzzy match jangan sampai nyasar ke karakter lain. Kalau NAMA-nya persis sama, mismatch elemen
  // berarti store Enka yang salah (Columbina "Pyro" padahal Hydro) → percaya genshin-db, catat sebagai override.
  const gdbElement = info.elementText ?? null;
  const exact = info.name === name;
  if (gdbElement && c.element && gdbElement !== c.element) {
    if (!exact) return { error: `element_mismatch (${gdbElement} vs ${c.element})`, gdbName: info.name };
    OVERRIDES.push({ avatarId: info.id, key: c.key, nameEn: info.name, element: gdbElement, note: `store Enka bilang ${c.element}` });
  }
  if (info.weaponType && c.weaponType && info.weaponType !== c.weaponType && !exact)
    return { error: `weapon_mismatch (${info.weaponType} vs ${c.weaponType})`, gdbName: info.name };

  const t = gdb.talents(info.name, { matchAliases: true });
  const k = gdb.constellations(info.name, { matchAliases: true });
  if (!t) return { error: "no_talents", gdbName: info.name };

  const passives = [];
  for (let i = 1; i <= 6; i++) {
    const p = t[`passive${i}`];
    if (!p) continue;
    passives.push({ slot: passiveSlot(i), name: p.name, description: p.description ?? "" });
  }
  const constellations = [];
  for (let n = 1; n <= 6; n++) {
    const cc = k?.[`c${n}`];
    if (cc) constellations.push({ n, name: cc.name, description: cc.description ?? "" });
  }

  return {
    data: {
      key: c.key,
      nameEn: c.nameEn,
      gdbName: info.name,
      element: c.element,
      weaponType: c.weaponType,
      version: t.version ?? info.version ?? null,
      talents: {
        normal: pickTalent(t.combat1),
        skill: pickTalent(t.combat2),
        burst: pickTalent(t.combat3),
      },
      passives,
      constellations,
    },
  };
}

function dumpWeapon(name) {
  const w = gdb.weapons(name);
  if (!w) return null;
  const refinements = {};
  for (let r = 1; r <= 5; r++) {
    const rr = w[`r${r}`];
    if (!rr) continue;
    refinements[`r${r}`] = { description: rr.description ?? "", values: rr.values ?? [] };
  }
  return {
    id: w.id ?? null,
    name: w.name,
    weaponType: w.weaponType ?? null,
    rarity: w.rarity ?? null,
    baseAtkLv1: w.baseAtkValue ?? null,
    mainStatType: w.mainStatType ?? null,
    effectName: w.effectName ?? null,
    effectTemplate: w.effectTemplateRaw ?? null,
    refinements,
  };
}

function dumpArtifact(name) {
  const a = gdb.artifacts(name);
  if (!a) return null;
  return {
    id: a.id ?? null,
    name: a.name,
    rarity: a.rarityList ?? null,
    twoPc: a.effect2Pc ?? a["2pc"] ?? null,
    fourPc: a.effect4Pc ?? a["4pc"] ?? null,
  };
}

async function writeJson(file, data) {
  await fs.writeFile(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

async function main() {
  const { only } = parseArgs();
  await Promise.all([OUT_TALENTS, OUT_WEAPONS, OUT_ARTIFACTS].map((d) => fs.mkdir(d, { recursive: true })));

  // --- karakter: store Enka + tambahan dari genshin-db yang belum ada di store ---
  const { list, seenIds, seenKeys } = await loadEnkaCharacters();
  const extra = extraCharactersFromGdb(seenIds, seenKeys);
  if (!only.size) {
    await writeJson(path.join(OUT, "enka-store-extra.json"), extra);
    console.log(`[extra] ${extra.length} karakter belum ada di store Enka: ${extra.map((e) => e.nameEn).join(", ") || "-"}`);
  }
  const chars = [...list, ...extra.map((e) => ({ key: e.key, nameEn: e.nameEn, element: e.element, weaponType: e.weaponType }))].filter(
    (c) => !only.size || only.has(c.key),
  );
  const unmatched = [];
  let okCount = 0;
  for (const c of chars) {
    const res = dumpCharacter(c);
    if (res.error) {
      unmatched.push({ key: c.key, nameEn: c.nameEn, reason: res.error, gdbName: res.gdbName ?? null });
      continue;
    }
    await writeJson(path.join(OUT_TALENTS, `${c.key}.json`), res.data);
    okCount++;
  }
  if (!only.size) {
    await writeJson(path.join(OUT_TALENTS, "_unmatched.json"), unmatched);
    // koreksi store Enka (elemen salah) — dibaca characterStore setelah build dari store
    await writeJson(path.join(OUT, "enka-store-overrides.json"), OVERRIDES);
    if (OVERRIDES.length) console.log(`[overrides] ${OVERRIDES.map((o) => `${o.nameEn} → ${o.element} (${o.note})`).join(", ")}`);
  }
  console.log(`[talents] ${okCount}/${chars.length} karakter ke-dump` + (unmatched.length ? `, ${unmatched.length} gagal:` : ""));
  for (const u of unmatched) console.log(`  - ${u.nameEn}: ${u.reason}`);

  if (only.size) return;

  // --- senjata (semua) ---
  const weaponNames = gdb.weapons("names", { matchCategories: true }) ?? [];
  let wc = 0;
  for (const n of weaponNames) {
    const w = dumpWeapon(n);
    if (!w) continue;
    await writeJson(path.join(OUT_WEAPONS, `${slugify(w.name)}.json`), w);
    wc++;
  }
  console.log(`[weapons] ${wc}/${weaponNames.length}`);

  // --- artifact set (semua) ---
  const artNames = gdb.artifacts("names", { matchCategories: true }) ?? [];
  let ac = 0;
  for (const n of artNames) {
    const a = dumpArtifact(n);
    if (!a) continue;
    await writeJson(path.join(OUT_ARTIFACTS, `${slugify(a.name)}.json`), a);
    ac++;
  }
  console.log(`[artifacts] ${ac}/${artNames.length}`);
  console.log(`genshin-db ${require("genshin-db/package.json").version}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
