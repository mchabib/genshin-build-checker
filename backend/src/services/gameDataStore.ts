import { promises as fs } from "node:fs";
import path from "node:path";
import type { TalentAttributes } from "../lib/talentLabel";

/**
 * Data game statis hasil `scripts/dump-genshin-db.mjs`:
 *   scrape-data/Talents/<Key>.json, Weapons/<slug>.json, Artifacts/<slug>.json
 * Dibaca sekali ke memori. Senjata & set di-index by nama ter-normalisasi karena
 * nama dari Enka (resolveNameHash) bisa beda kapitalisasi/tanda baca.
 */

export interface TalentEntry {
  name: string;
  description: string;
  attributes: TalentAttributes;
}
export interface StoredTalentData {
  key: string;
  nameEn: string;
  gdbName: string;
  element: string | null;
  weaponType: string | null;
  version: string | null;
  talents: { normal: TalentEntry | null; skill: TalentEntry | null; burst: TalentEntry | null };
  passives: { slot: "a1" | "a4" | "util" | "other"; name: string; description: string }[];
  constellations: { n: number; name: string; description: string }[];
}
export interface StoredWeapon {
  /** id item game (= itemId di Enka), buat fallback nama kalau hash belum ada di loc.json */
  id?: number | null;
  name: string;
  weaponType: string | null;
  rarity: number | null;
  baseAtkLv1: number | null;
  mainStatType: string | null;
  effectName: string | null;
  effectTemplate: string | null;
  refinements: Record<string, { description: string; values: string[] }>;
}
export interface StoredArtifact {
  /** id set game (= angka di icon Enka "UI_RelicIcon_15046_4") */
  id?: number | null;
  name: string;
  rarity: number[] | null;
  twoPc: string | null;
  fourPc: string | null;
}

const DATA_DIR = process.env.GAME_DATA_DIR ?? path.resolve("scrape-data");

let talentsByKey = new Map<string, StoredTalentData>();
let weaponsByName = new Map<string, StoredWeapon>();
let artifactsByName = new Map<string, StoredArtifact>();
let weaponsById = new Map<number, StoredWeapon>();
let artifactsById = new Map<number, StoredArtifact>();
let loaded = false;
let loadingPromise: Promise<void> | null = null;

export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function readDir<T>(sub: string): Promise<T[]> {
  const dir = path.join(DATA_DIR, sub);
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json") && !f.startsWith("_"));
  } catch {
    console.warn(`[gameDataStore] ${dir} nggak ada — jalankan npm run dump:gdb`);
    return [];
  }
  const out: T[] = [];
  for (const f of files) {
    try {
      out.push(JSON.parse(await fs.readFile(path.join(dir, f), "utf8")) as T);
    } catch (err) {
      console.warn(`[gameDataStore] gagal baca ${sub}/${f}: ${(err as Error).message}`);
    }
  }
  return out;
}

async function doLoad(): Promise<void> {
  const [talents, weapons, artifacts] = await Promise.all([
    readDir<StoredTalentData>("Talents"),
    readDir<StoredWeapon>("Weapons"),
    readDir<StoredArtifact>("Artifacts"),
  ]);
  talentsByKey = new Map(talents.map((t) => [t.key, t]));
  weaponsByName = new Map(weapons.map((w) => [normalizeName(w.name), w]));
  artifactsByName = new Map(artifacts.map((a) => [normalizeName(a.name), a]));
  weaponsById = new Map(weapons.filter((w) => w.id).map((w) => [w.id!, w]));
  artifactsById = new Map(artifacts.filter((a) => a.id).map((a) => [a.id!, a]));
  loaded = true;
  console.log(
    `[gameDataStore] loaded ${talentsByKey.size} talent, ${weaponsByName.size} senjata, ${artifactsByName.size} set`,
  );
}

/** Pastikan store sudah dimuat (idempotent). */
export function loadGameDataStore(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (!loadingPromise) loadingPromise = doLoad();
  return loadingPromise;
}

export function getTalentData(characterKey: string): StoredTalentData | null {
  return talentsByKey.get(characterKey) ?? null;
}

export function getWeapon(name: string | null | undefined): StoredWeapon | null {
  if (!name) return null;
  return weaponsByName.get(normalizeName(name)) ?? null;
}

/** Teks efek senjata di refinement tertentu (fallback ke r1 / template). */
export function getWeaponText(name: string | null | undefined, refinement = 1): string | null {
  const w = getWeapon(name);
  if (!w) return null;
  const r = w.refinements[`r${Math.min(Math.max(refinement, 1), 5)}`] ?? w.refinements.r1;
  return r?.description ?? w.effectTemplate ?? null;
}

/** Fallback nama senjata dari itemId Enka (buat item baru yang hash-nya belum ada di loc.json). */
export function weaponNameById(itemId: number | undefined): string | null {
  return itemId != null ? weaponsById.get(itemId)?.name ?? null : null;
}

/** Fallback nama set dari icon Enka "UI_RelicIcon_15046_4" → id 15046. */
export function artifactSetNameFromIcon(icon: string | undefined): string | null {
  const m = icon?.match(/UI_RelicIcon_(\d+)_/);
  return m ? artifactsById.get(Number(m[1]))?.name ?? null : null;
}

export function getArtifact(setName: string | null | undefined): StoredArtifact | null {
  if (!setName) return null;
  return artifactsByName.get(normalizeName(setName)) ?? null;
}

export function gameDataStats() {
  return {
    loaded,
    talents: talentsByKey.size,
    weapons: weaponsByName.size,
    artifacts: artifactsByName.size,
  };
}
