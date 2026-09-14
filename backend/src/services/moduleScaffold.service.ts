import { promises as fs } from "node:fs";
import path from "node:path";
import { getTalentData, loadGameDataStore, type StoredTalentData } from "./gameDataStore";
import { getGuide, loadGuideStore, type StoredGuide } from "./guideStore";
import { findCharacterByQuery, loadCharacterStore, resolveByKey } from "./characterStore";
import { loadBuffStore, type CharacterModule, type RawBuffEntry } from "./buffStore";
import { buildHits } from "./damage.run";
import { parseKqmTeams } from "./damage.rules";
import { pickKqmCombo } from "../lib/kqmCombo";

/**
 * Scaffold modul karakter `scrape-data/Buffs/<Key>.json` dari data yang sudah ada:
 * hit list (dump talent), passive A1/A4 + C1–C6 sebagai entry `mode: "manual"` dengan deskripsi asli
 * (angka diisi tangan), rotasi dari notasi combo KQM, tim dari guide KQM. Penulis tinggal isi `mod`.
 */

export interface ScaffoldResult {
  key: string;
  file: string;
  module: CharacterModule & { _comment: string; _hits: string[] };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

function guessRole(guide: StoredGuide | null, td: StoredTalentData): CharacterModule["role"] {
  const text = `${guide?.raw.overview ?? ""} ${guide?.raw.playstyles ?? ""} ${td.talents.burst?.description ?? ""}`.toLowerCase();
  if (/\bshield/.test(text) && /shielder|shield bot|provides? (a )?shield/.test(text)) return "shielder";
  if (/\bheal(er|ing)\b/.test(text) && /healer|sustain/.test(text)) return "healer";
  if (/\bbuffer\b|buffs? (the|your) (team|party|on-?field)/.test(text)) return "buffer";
  if (/off-?field|sub-?dps|enabler/.test(text)) return "subdps";
  if (/\bsupport\b/.test(text) && !/on-?field dps|main dps/.test(text)) return "support";
  return "dps";
}

export function scaffoldModule(key: string, td: StoredTalentData, guide: StoredGuide | null): ScaffoldResult["module"] {
  const { hits } = buildHits(key, td);
  const self: RawBuffEntry[] = [];
  const id = (s: string) => `${slug(key)}_${s}`;
  for (const p of td.passives) {
    if (p.slot !== "a1" && p.slot !== "a4") continue;
    self.push({
      id: id(p.slot),
      description: `${p.slot.toUpperCase()} ${p.name}: ${p.description.replace(/\s+/g, " ").trim()}`,
      mode: "manual",
      mod: { source: `${td.nameEn} ${p.slot.toUpperCase()}`, scope: "all" },
    });
  }
  for (const c of td.constellations) {
    self.push({
      id: id(`c${c.n}`),
      description: `C${c.n} ${c.name}: ${c.description.replace(/\s+/g, " ").trim()}`,
      mode: "manual",
      requireCon: c.n,
      mod: { source: `${td.nameEn} C${c.n}`, scope: "all" },
    });
  }

  const rotations: NonNullable<CharacterModule["rotations"]> = [];
  const combo = guide ? pickKqmCombo(guide.raw, hits, {}) : null;
  if (combo)
    rotations.push({
      label: `KQM: ${combo.notation}`,
      kqm: combo.repeat > 1 ? `${combo.repeat}[${combo.notation}]` : combo.notation,
      note: `${combo.note} — cek: E/Q kena SEMUA varian hit; pakai counts kalau ada varian yang nggak semua kena`,
    });
  else rotations.push({ label: "TODO rotasi", counts: Object.fromEntries(hits.filter((h) => h.id !== "plunge1").map((h) => [h.id, 1])), duration: 20, note: "generik 1× tiap hit — ganti dengan combo KQM / counts beneran" });

  const resolveKey = (q: string) => findCharacterByQuery(q)?.key ?? null;
  const teams = guide ? parseKqmTeams(guide, resolveKey, key).slice(0, 3) : [];

  return {
    key,
    _comment:
      "Dibuat `npm run module:new`. Isi angka di `mod` tiap entry (lihat _README.md), ganti mode manual → always/assume kalau wajar dianggap aktif, hapus entry yang nggak ngaruh damage. `_hits` cuma referensi id hit (diabaikan loader).",
    role: guessRole(guide, td),
    _hits: hits.map((h) => `${h.id}: ${h.label} [${h.kind}]`),
    self,
    rotations,
    ...(teams.length ? { teams } : {}),
  };
}

export async function createModuleFile(query: string, opts: { force?: boolean; dir?: string } = {}): Promise<ScaffoldResult> {
  await Promise.all([loadCharacterStore(), loadGuideStore(), loadGameDataStore(), loadBuffStore()]);
  const key = resolveByKey(query)?.key ?? findCharacterByQuery(query)?.key ?? null;
  if (!key) throw new Error(`karakter "${query}" nggak ketemu`);
  const td = getTalentData(key);
  if (!td) throw new Error(`nggak ada data talent buat ${key} (npm run dump:gdb)`);
  const dir = opts.dir ?? path.join(process.env.GAME_DATA_DIR ?? path.resolve("scrape-data"), "Buffs");
  const file = path.join(dir, `${key}.json`);
  if (!opts.force) {
    try {
      await fs.access(file);
      throw new Error(`${file} sudah ada — pakai --force buat nimpa`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  const module = scaffoldModule(key, td, getGuide(key));
  await fs.writeFile(file, JSON.stringify(module, null, 2) + "\n", "utf8");
  return { key, file, module };
}
