import { promises as fs } from "node:fs";
import path from "node:path";
import { allResolved, loadCharacterStore } from "./characterStore";

/**
 * Guide KQM statis. Baca semua file di `scrape-data/<slug>.json` sekali pas startup,
 * simpen di memori, index by character key. Nggak ada database — file JSON ini
 * yang jadi "database"-nya.
 *
 * Refresh data: `node scripts/scrape-kqm.mjs` lalu restart backend.
 */

export interface GuideBuildRaw {
  name: string | null;
  sands: string[];
  goblet: string[];
  circlet: string[];
  substatPriority: string[];
}
export interface GuideErRequirement {
  label: string;
  min: number;
  max: number | null;
}
export interface GuideSetRaw {
  pieces: number;
  name: string;
  note: string | null;
}
export interface GuideParsed {
  erRequirements?: GuideErRequirement[];
  builds?: GuideBuildRaw[];
  sets?: GuideSetRaw[];
  weaponsRanked?: string[];
  constellations?: Record<string, string>;
  talentPriority?: string | null;
}

export interface StoredGuide {
  slug: string;
  kqmName: string;
  canonName: string;
  sourceUrl: string;
  guideUpdated: string | null;
  scrapedAt: string;
  /** teks section apa adanya, key camelCase dari judul heading KQM */
  raw: Record<string, string>;
  parsed: GuideParsed;
}

const SCRAPE_DIR =
  process.env.KQM_SCRAPE_DIR ?? path.resolve("scrape-data/Character");

let byKey = new Map<string, StoredGuide>();
let unmatchedNames: string[] = [];
let loaded = false;
let loadingPromise: Promise<void> | null = null;

async function doLoad(): Promise<void> {
  await loadCharacterStore();
  const nameToKey = new Map(
    allResolved().map((c) => [c.nameEn.toLowerCase(), c.key]),
  );

  let files: string[];
  try {
    files = (await fs.readdir(SCRAPE_DIR)).filter(
      (f) => f.endsWith(".json") && !f.startsWith("_"),
    );
  } catch {
    console.warn(
      `[guideStore] ${SCRAPE_DIR} nggak ada — jalankan scripts/scrape-kqm.mjs`,
    );
    loaded = true;
    return;
  }

  const map = new Map<string, StoredGuide>();
  const unmatched: string[] = [];
  for (const file of files) {
    let g: StoredGuide;
    try {
      g = JSON.parse(await fs.readFile(path.join(SCRAPE_DIR, file), "utf8"));
    } catch (err) {
      console.warn(`[guideStore] gagal baca ${file}: ${(err as Error).message}`);
      continue;
    }
    const key = nameToKey.get((g.canonName ?? "").toLowerCase());
    // nama yang nggak ketemu = karakter beta / belum rilis (belum ada di Enka store)
    if (!key) {
      unmatched.push(g.canonName ?? file);
      continue;
    }
    map.set(key, g);
  }

  byKey = map;
  unmatchedNames = unmatched;
  loaded = true;
  console.log(
    `[guideStore] loaded ${map.size} guide KQM` +
      (unmatched.length ? ` (${unmatched.length} di-skip: beta/belum rilis)` : ""),
  );
}

/** Pastikan guide store sudah dimuat (idempotent). */
export function loadGuideStore(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (!loadingPromise) loadingPromise = doLoad();
  return loadingPromise;
}

export function getGuide(characterKey: string): StoredGuide | null {
  return byKey.get(characterKey) ?? null;
}

export function hasGuide(characterKey: string): boolean {
  return byKey.has(characterKey);
}

export function guideKeys(): Set<string> {
  return new Set(byKey.keys());
}

export function allGuides(): StoredGuide[] {
  return [...byKey.values()];
}

export function guideStoreStats() {
  return { loaded, guides: byKey.size, unmatched: unmatchedNames };
}
