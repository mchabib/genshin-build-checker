import { promises as fs } from "node:fs";
import path from "node:path";
import { loadBuffStore, evalExpr, resolveModifier, type ExprContext, type RawBuffEntry, type TeamBuffEntry, type SetBuffEntry, type WeaponBuffEntry, type CharacterModule } from "./buffStore";
import { getArtifact, getTalentData, getWeapon, loadGameDataStore } from "./gameDataStore";
import { loadCharacterStore, resolveByKey } from "./characterStore";
import { buildHits } from "./damage.run";
import { parseKqmCombo } from "../lib/kqmCombo";
import { ELEMENTS } from "../lib/stats";
import type { DamageCharacter } from "./damage.service";
import type { HitDef } from "./damage.types";

/**
 * Validator data tangan `scrape-data/Buffs/` (`npm run check:buffs`, juga jalan di `npm test`).
 * Nangkep yang biasanya baru ketahuan pas runtime: JSON rusak, hit id salah, token notasi/durasi nggak
 * dikenal, nama set/senjata/karakter nggak ada di dump, field Modifier typo, ekspresi yang meledak
 * (termasuk kalau teammate nggak ada di showcase → `tm()` null).
 */

export interface BuffCheckIssue {
  level: "error" | "warn";
  file: string;
  where: string;
  message: string;
}

const MOD_KEYS = new Set([
  "id", "source", "scope", "hitIds", "hitLabelMatch", "atkPct", "atkFlat", "hpPct", "hpFlat", "defPct", "defFlat", "em",
  "atkFromStat", "critRate", "critDmg", "dmgBonus", "elementalDmgBonus", "reactionBonus", "defShred", "defIgnore", "resShred",
  "talentMultBonus", "talentMultAdd", "flatDmg", "stellarBonus", "lunarBaseBonus", "lunarBonus", "infusion", "uptime", "note",
]);
const SCOPES = new Set(["all", "na", "ca", "plunge", "skill", "burst"]);
const MODES = new Set(["always", "assume", "manual"]);
const ROLES = new Set(["dps", "subdps", "support", "shielder", "healer", "buffer"]);
const TOKEN_RE = /^(N\d+|hP|lP|JP|tE|hE|pE|[CEQPJD])$/;
const ENTRY_KEYS = new Set([
  "id", "description", "mode", "onlyElements", "requireCon", "requireTeamElement", "requireSet", "duration", "cooldown", "mod",
  "fromCharacter", "assumeWith", "resonance", "requiresAction", "set", "weapon",
]);
const MODULE_KEYS = new Set(["key", "role", "naElements", "self", "reactions", "rotations", "actions", "durations", "limits", "_limits_comment", "_actions_comment", "teams", "_comment", "_hits"]);

const dummyChar: DamageCharacter = {
  key: "X", level: 90, element: "pyro",
  naElements: { na: "pyro", ca: "pyro", plunge: "pyro" },
  talentLevels: { normal: 10, skill: 10, burst: 10 },
  final: { hp: 20000, atk: 2000, def: 800, em: 100, critRate: 60, critDmg: 150 },
  base: { hp: 12000, atk: 800, def: 700 },
  dmgBonus: { pyro: 46.6, hydro: 0, electro: 0, cryo: 0, dendro: 0, anemo: 0, geo: 0, physical: 0 },
};

/** 2 konteks: teammate ADA (angka wajar) dan teammate NGGAK ADA (tm null, tp undefined) */
function contexts(): { name: string; ctx: ExprContext }[] {
  const base = {
    char: dummyChar, er: 150,
    team: { keys: ["A", "B", "C"], elements: ["pyro", "hydro", "anemo"], count: 3, sameElementCount: 0 },
    wv: (i: number) => [10, 20, 30, 40][i] ?? 0,
  };
  const withMate: ExprContext = {
    ...base, con: 6,
    p: () => 0.5, tp: () => 0.5,
    tm: () => ({ key: "T", baseAtk: 800, em: 200, con: 6, constellation: 6, talentLevels: { normal: 10, skill: 10, burst: 10 } }),
    meta: () => ({ duration: 10, cd: 15 }), tmeta: () => ({ duration: 12, cd: 15 }),
  };
  const noMate: ExprContext = {
    ...base, con: 0,
    p: () => undefined, tp: () => undefined, tm: () => null,
    meta: () => ({}), tmeta: () => ({}),
    team: { keys: [], elements: ["pyro"], count: 0, sameElementCount: 0 },
  };
  return [
    { name: "teammate ada / C6", ctx: withMate },
    { name: "teammate nggak ada / C0", ctx: noMate },
  ];
}

function walkExprs(v: unknown, out: string[]): void {
  if (typeof v === "string" && v.trimStart().startsWith("=")) out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => walkExprs(x, out));
  else if (v && typeof v === "object") Object.values(v as Record<string, unknown>).forEach((x) => walkExprs(x, out));
}

function checkEntry(e: RawBuffEntry & Partial<TeamBuffEntry>, file: string, hits: HitDef[] | null, push: (i: BuffCheckIssue) => void, seenIds: Map<string, string>) {
  const where = e.id ?? "(tanpa id)";
  if (!e.id) push({ level: "error", file, where, message: "entry tanpa `id`" });
  else if (seenIds.has(e.id)) push({ level: "error", file, where, message: `id duplikat (juga di ${seenIds.get(e.id)})` });
  else seenIds.set(e.id, file);
  for (const k of Object.keys(e)) if (!ENTRY_KEYS.has(k)) push({ level: "warn", file, where, message: `field entry nggak dikenal: \`${k}\`` });
  if (e.mode && !MODES.has(e.mode)) push({ level: "error", file, where, message: `mode "${e.mode}" bukan always|assume|manual` });
  if (e.onlyElements?.some((x) => !ELEMENTS.includes(x))) push({ level: "error", file, where, message: `onlyElements punya elemen nggak dikenal: ${e.onlyElements.join(",")}` });
  if (e.requireTeamElement && !ELEMENTS.includes(e.requireTeamElement)) push({ level: "error", file, where, message: `requireTeamElement "${e.requireTeamElement}" nggak dikenal` });
  if (e.resonance && !ELEMENTS.includes(e.resonance)) push({ level: "error", file, where, message: `resonance "${e.resonance}" nggak dikenal` });
  if (e.requiresAction && e.requiresAction !== "skill" && e.requiresAction !== "burst") push({ level: "error", file, where, message: `requiresAction "${e.requiresAction}" bukan skill|burst` });
  if (e.requireSet && !getArtifact(e.requireSet)) push({ level: "error", file, where, message: `requireSet "${e.requireSet}" nggak ada di scrape-data/Artifacts` });
  if (e.fromCharacter && !resolveByKey(e.fromCharacter)) push({ level: "error", file, where, message: `fromCharacter "${e.fromCharacter}" bukan key karakter` });
  for (const k of e.assumeWith ?? []) if (!resolveByKey(k)) push({ level: "error", file, where, message: `assumeWith "${k}" bukan key karakter` });
  if (!e.mod || typeof e.mod !== "object") {
    push({ level: "error", file, where, message: "entry tanpa `mod`" });
    return;
  }
  for (const k of Object.keys(e.mod)) if (!MOD_KEYS.has(k)) push({ level: "error", file, where, message: `field mod nggak dikenal: \`${k}\` (typo?)` });
  const scope = e.mod.scope;
  for (const s of Array.isArray(scope) ? scope : scope != null ? [scope] : [])
    if (typeof s !== "string" || !SCOPES.has(s)) push({ level: "error", file, where, message: `scope "${String(s)}" nggak dikenal` });
  if (hits && Array.isArray(e.mod.hitIds))
    for (const id of e.mod.hitIds as unknown[]) if (!hits.some((h) => h.id === id)) push({ level: "error", file, where, message: `hitIds "${String(id)}" nggak ada di tabel hit` });
  if (typeof e.mod.hitLabelMatch === "string") {
    try {
      new RegExp(e.mod.hitLabelMatch);
    } catch {
      push({ level: "error", file, where, message: `hitLabelMatch bukan regex valid` });
    }
  }
  if (typeof e.mod.uptime === "number" && (e.mod.uptime < 0 || e.mod.uptime > 1)) push({ level: "error", file, where, message: `uptime ${e.mod.uptime} di luar 0-1` });

  // ekspresi: harus bisa dievaluasi di 2 konteks (teammate ada / nggak)
  for (const { name, ctx } of contexts()) {
    try {
      resolveModifier(e.id ?? "x", e.mod, ctx, "pyro");
      for (const f of ["duration", "cooldown"] as const) {
        const v = e[f];
        if (typeof v === "string" && v.trimStart().startsWith("=")) {
          const r = evalExpr(v, ctx);
          if (typeof r !== "number" || !Number.isFinite(r)) push({ level: "warn", file, where, message: `${f} "${v}" bukan angka di konteks ${name} (${String(r)})` });
        }
      }
    } catch (err) {
      const exprs: string[] = [];
      walkExprs(e.mod, exprs);
      push({ level: "error", file, where, message: `ekspresi gagal (${name}): ${(err as Error).message} — ${exprs.join(" | ").slice(0, 160)}` });
    }
  }
}

export async function checkBuffs(dir = path.join(process.env.GAME_DATA_DIR ?? path.resolve("scrape-data"), "Buffs")): Promise<BuffCheckIssue[]> {
  await Promise.all([loadCharacterStore(), loadGameDataStore(), loadBuffStore()]);
  const issues: BuffCheckIssue[] = [];
  const push = (i: BuffCheckIssue) => issues.push(i);
  const seenIds = new Map<string, string>();

  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
  const readJson = async (f: string): Promise<unknown> => {
    let text: string;
    try {
      text = await fs.readFile(path.join(dir, f), "utf8");
    } catch {
      return null; // file _*.json opsional
    }
    try {
      return JSON.parse(text);
    } catch (err) {
      push({ level: "error", file: f, where: "-", message: `JSON rusak: ${(err as Error).message}` });
      return null;
    }
  };

  // ---- _team / _sets / _weapons ----
  const team = (await readJson("_team.json")) as TeamBuffEntry[] | null;
  for (const e of team ?? []) checkEntry(e, "_team.json", null, push, seenIds);
  const sets = (await readJson("_sets.json")) as SetBuffEntry[] | null;
  for (const e of sets ?? []) {
    if (!e.set) push({ level: "error", file: "_sets.json", where: e.id, message: "entry tanpa `set`" });
    else if (!getArtifact(e.set)) push({ level: "error", file: "_sets.json", where: e.id, message: `set "${e.set}" nggak ada di scrape-data/Artifacts` });
    checkEntry(e, "_sets.json", null, push, seenIds);
  }
  const weapons = (await readJson("_weapons.json")) as WeaponBuffEntry[] | null;
  for (const e of weapons ?? []) {
    if (!e.weapon) push({ level: "error", file: "_weapons.json", where: e.id, message: "entry tanpa `weapon`" });
    else if (!getWeapon(e.weapon)) push({ level: "error", file: "_weapons.json", where: e.id, message: `senjata "${e.weapon}" nggak ada di scrape-data/Weapons` });
    checkEntry(e, "_weapons.json", null, push, seenIds);
  }

  // ---- _durations ----
  const durations = (await readJson("_durations.json")) as Record<string, Record<string, number>> | null;
  for (const [table, map] of Object.entries(durations ?? {})) {
    if (table.startsWith("_")) continue;
    for (const [tok, v] of Object.entries(map))
      if (!TOKEN_RE.test(tok)) push({ level: "error", file: "_durations.json", where: table, message: `token "${tok}" bukan token notasi` });
      else if (typeof v !== "number" || v < 0) push({ level: "error", file: "_durations.json", where: table, message: `durasi ${tok} bukan angka` });
  }

  // ---- modul karakter ----
  for (const f of files.filter((x) => !x.startsWith("_"))) {
    const m = (await readJson(f)) as CharacterModule | null;
    if (!m) continue;
    const where = m.key ?? f;
    if (!m.key) {
      push({ level: "error", file: f, where, message: "modul tanpa `key`" });
      continue;
    }
    if (f !== `${m.key}.json`) push({ level: "warn", file: f, where, message: `nama file beda dengan key (${m.key}.json)` });
    for (const k of Object.keys(m)) if (!MODULE_KEYS.has(k)) push({ level: "warn", file: f, where, message: `field modul nggak dikenal: \`${k}\`` });
    if (!resolveByKey(m.key)) push({ level: "warn", file: f, where, message: `key "${m.key}" nggak ada di store karakter Enka` });
    if (m.role && !ROLES.has(m.role)) push({ level: "error", file: f, where, message: `role "${m.role}" nggak dikenal` });
    for (const [k, el] of Object.entries(m.naElements ?? {}))
      if (!["na", "ca", "plunge"].includes(k) || !ELEMENTS.includes(el)) push({ level: "error", file: f, where, message: `naElements ${k}=${el} nggak valid` });

    const td = getTalentData(m.key);
    if (!td) {
      push({ level: "error", file: f, where, message: `nggak ada data talent buat "${m.key}" (npm run dump:gdb)` });
      continue;
    }
    const { hits } = buildHits(m.key, td);
    const hasHit = (id: string) => hits.some((h) => h.id === id) || id.startsWith("react:");

    for (const e of m.self ?? []) checkEntry(e, f, hits, push, seenIds);

    for (const [tok, map] of Object.entries(m.actions ?? {})) {
      if (!TOKEN_RE.test(tok)) push({ level: "error", file: f, where: `actions.${tok}`, message: "bukan token notasi" });
      for (const id of Object.keys(map)) if (!hasHit(id)) push({ level: "error", file: f, where: `actions.${tok}`, message: `hit "${id}" nggak ada di tabel` });
    }
    for (const [tok, lim] of Object.entries(m.limits ?? {})) {
      if (!TOKEN_RE.test(tok)) push({ level: "error", file: f, where: `limits.${tok}`, message: "bukan token notasi" });
      if (typeof lim.max !== "number" || lim.max < 1) push({ level: "error", file: f, where: `limits.${tok}`, message: "`max` harus angka ≥ 1" });
      for (const r of lim.resetBy ?? []) if (!TOKEN_RE.test(r)) push({ level: "error", file: f, where: `limits.${tok}`, message: `resetBy "${r}" bukan token notasi` });
      for (const id of Object.keys(lim.overflow ?? {})) if (!hasHit(id)) push({ level: "error", file: f, where: `limits.${tok}`, message: `overflow hit "${id}" nggak ada di tabel` });
    }
    for (const [tok, v] of Object.entries(m.durations ?? {})) {
      if (!TOKEN_RE.test(tok)) push({ level: "error", file: f, where: `durations.${tok}`, message: "bukan token notasi" });
      if (typeof v !== "number" || v < 0) push({ level: "error", file: f, where: `durations.${tok}`, message: "bukan angka" });
    }
    (m.rotations ?? []).forEach((r, i) => {
      const w = `rotations[${i}]`;
      if (r.counts) {
        for (const id of Object.keys(r.counts)) if (!hasHit(id)) push({ level: "error", file: f, where: w, message: `counts hit "${id}" nggak ada di tabel` });
        if (!r.duration) push({ level: "warn", file: f, where: w, message: "preset counts tanpa `duration` → DPS/uptime nyata nggak dihitung" });
      }
      if (r.kqm) {
        const p = parseKqmCombo(r.kqm, hits, m.actions ?? {}, m.limits ?? {});
        if (p.unknown.length) push({ level: "error", file: f, where: w, message: `notasi "${r.kqm}": token nggak dikenal ${p.unknown.join(",")}` });
        if (!Object.keys(p.counts).length) push({ level: "error", file: f, where: w, message: `notasi "${r.kqm}" nggak menghasilkan hit` });
      }
      if (!r.counts && !r.kqm) push({ level: "error", file: f, where: w, message: "preset tanpa counts maupun kqm" });
    });
    for (const [el, map] of Object.entries(m.reactions?.with ?? {})) {
      if (!(ELEMENTS as readonly string[]).includes(el)) push({ level: "error", file: f, where: `reactions.with.${el}`, message: "elemen nggak dikenal" });
      for (const kind of Object.keys(map)) if (!SCOPES.has(kind) || kind === "all") push({ level: "error", file: f, where: `reactions.with.${el}`, message: `jenis hit "${kind}" nggak dikenal` });
    }
    (m.teams ?? []).forEach((t, i) => {
      for (const k of t) if (!resolveByKey(k)) push({ level: "warn", file: f, where: `teams[${i}]`, message: `"${k}" bukan key karakter` });
    });
  }

  return issues;
}
