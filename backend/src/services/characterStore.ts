import { promises as fs } from "node:fs";
import path from "node:path";
import {
  deriveKey,
  ELEMENT_MAP,
  WEAPON_MAP,
  qualityToRarity,
} from "../lib/characterKey";
import { CHARACTERS } from "../data/characters";

/**
 * Loader untuk Enka.Network "store" (mapping avatarId -> nama/element/senjata).
 * Enka API cuma ngasih avatarId (angka), jadi butuh file ini buat resolve nama.
 * Sumber:
 *   https://raw.githubusercontent.com/EnkaNetwork/API-docs/master/store/characters.json
 *   https://raw.githubusercontent.com/EnkaNetwork/API-docs/master/store/loc.json
 * Di-cache ke disk, refresh tiap 7 hari. Kalau download gagal & cache kosong,
 * fallback ke daftar hardcoded di data/characters.ts.
 */

export interface ResolvedCharacter {
  avatarId: number;
  key: string;
  name: string; // nama terlokalisasi (default: id, fallback en)
  nameEn: string;
  element: string | null;
  weaponType: string | null;
  rarity: number;
  /** [normalAttackId, skillId, burstId] dari characters.json */
  skillOrder: number[];
  /** skillId -> proudSkillId; dipakai buat baca proudSkillExtraLevelMap (C3/C5 +3) */
  proudMap: Record<string, number>;
}

const STORE_BASE =
  process.env.ENKA_STORE_BASE ??
  "https://raw.githubusercontent.com/EnkaNetwork/API-docs/master/store";
const CACHE_DIR = process.env.ENKA_STORE_CACHE_DIR ?? path.resolve(".cache/enka");
/** karakter yang belum masuk store GitHub Enka, hasil `npm run dump:gdb` (dari genshin-db) */
const EXTRA_FILE = path.join(process.env.GAME_DATA_DIR ?? path.resolve("scrape-data"), "enka-store-extra.json");
const OVERRIDES_FILE = path.join(process.env.GAME_DATA_DIR ?? path.resolve("scrape-data"), "enka-store-overrides.json");

interface ExtraEntry {
  avatarId: number;
  /** key-nya sudah dipakai avatarId lain di store Enka → entri lama diganti */
  replacesKey?: boolean;
  key: string;
  nameEn: string;
  element: string | null;
  weaponType: string | null;
  rarity: number;
}
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const LOCALE = process.env.ENKA_STORE_LOCALE ?? "id";

interface CharactersJsonEntry {
  Element?: string;
  WeaponType?: string;
  NameTextMapHash?: number | string;
  QualityType?: string;
  SkillOrder?: number[];
  ProudMap?: Record<string, number>;
}
type CharactersJson = Record<string, CharactersJsonEntry>;
type LocJson = Record<string, Record<string, string>>;

let byId: Map<number, ResolvedCharacter> = new Map();
let locLang: Record<string, string> = {};
let locEn: Record<string, string> = {};
let loaded = false;
let loadingPromise: Promise<void> | null = null;

async function readCached(file: string): Promise<string | null> {
  try {
    const full = path.join(CACHE_DIR, file);
    const stat = await fs.stat(full);
    if (Date.now() - stat.mtimeMs > MAX_AGE_MS) return null;
    return await fs.readFile(full, "utf8");
  } catch {
    return null;
  }
}

async function fetchAndCache(file: string): Promise<string | null> {
  try {
    const res = await fetch(`${STORE_BASE}/${file}`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(path.join(CACHE_DIR, file), text, "utf8");
    return text;
  } catch (err) {
    console.warn(`[characterStore] gagal fetch ${file}: ${(err as Error).message}`);
    return null;
  }
}

async function getFile(file: string): Promise<string | null> {
  const cached = await readCached(file);
  if (cached) return cached;
  const fresh = await fetchAndCache(file);
  if (fresh) return fresh;
  // kalau fetch gagal, coba cache basi sebagai upaya terakhir
  try {
    return await fs.readFile(path.join(CACHE_DIR, file), "utf8");
  } catch {
    return null;
  }
}

function buildFromStore(characters: CharactersJson, loc: LocJson): Map<number, ResolvedCharacter> {
  const map = new Map<number, ResolvedCharacter>();
  const usedKeys = new Set<string>();
  locLang = loc[LOCALE] ?? {};
  locEn = loc.en ?? {};

  for (const [rawKey, entry] of Object.entries(characters)) {
    // skip varian Traveler ("10000005-anemo", dst) — jarang di-showcase buat cek build
    const avatarId = Number.parseInt(rawKey, 10);
    if (!Number.isFinite(avatarId)) continue;
    if (avatarId === 10000005 || avatarId === 10000007) continue;
    if (map.has(avatarId)) continue;

    const hash = entry.NameTextMapHash != null ? String(entry.NameTextMapHash) : "";
    const nameEn = locEn[hash];
    if (!nameEn) continue; // tanpa nama Inggris, key nggak stabil — skip

    const key = deriveKey(nameEn);
    if (usedKeys.has(key)) continue; // nama duplikat (mis. entri beta) — skip
    usedKeys.add(key);

    map.set(avatarId, {
      avatarId,
      key,
      name: locLang[hash] || nameEn,
      nameEn,
      element: entry.Element ? ELEMENT_MAP[entry.Element] ?? entry.Element : null,
      weaponType: entry.WeaponType ? WEAPON_MAP[entry.WeaponType] ?? null : null,
      rarity: qualityToRarity(entry.QualityType ?? ""),
      skillOrder: Array.isArray(entry.SkillOrder) ? entry.SkillOrder : [],
      proudMap: entry.ProudMap ?? {},
    });
  }
  return map;
}

function fallbackMap(): Map<number, ResolvedCharacter> {
  const map = new Map<number, ResolvedCharacter>();
  for (const c of CHARACTERS) {
    map.set(c.enkaAvatarId, {
      avatarId: c.enkaAvatarId,
      key: c.key,
      name: c.name,
      nameEn: c.name,
      element: c.element,
      weaponType: c.weaponType,
      rarity: c.rarity,
      skillOrder: [],
      proudMap: {},
    });
  }
  return map;
}

async function doLoad(): Promise<void> {
  const [charactersText, locText] = await Promise.all([
    getFile("characters.json"),
    getFile("loc.json"),
  ]);

  if (charactersText && locText) {
    try {
      byId = buildFromStore(
        JSON.parse(charactersText) as CharactersJson,
        JSON.parse(locText) as LocJson,
      );
      console.log(`[characterStore] loaded ${byId.size} karakter dari Enka store`);
    } catch (err) {
      console.warn(`[characterStore] parse error: ${(err as Error).message}`);
    }
  }

  if (byId.size === 0) {
    byId = fallbackMap();
    console.warn(`[characterStore] pakai fallback hardcoded (${byId.size} karakter)`);
  }

  // karakter baru yang belum ada di store GitHub (repo docs Enka sering telat beberapa patch)
  try {
    const extra = JSON.parse(await fs.readFile(EXTRA_FILE, "utf8")) as ExtraEntry[];
    const usedKeys = new Set([...byId.values()].map((c) => c.key));
    let added = 0;
    for (const e of extra) {
      if (byId.has(e.avatarId)) continue;
      if (usedKeys.has(e.key)) {
        // store Enka punya entri lain dengan nama sama (id uji/placeholder) → ganti dengan id genshin-db
        const old = [...byId.entries()].find(([, c]) => c.key === e.key);
        if (!old || !e.replacesKey) continue;
        byId.delete(old[0]);
        console.log(`[characterStore] ${e.key}: id ${old[0]} (store Enka) diganti ${e.avatarId} (genshin-db)`);
      }
      byId.set(e.avatarId, {
        avatarId: e.avatarId,
        key: e.key,
        name: e.nameEn,
        nameEn: e.nameEn,
        element: e.element,
        weaponType: e.weaponType ? WEAPON_MAP[e.weaponType] ?? null : null,
        rarity: e.rarity ?? 5,
        skillOrder: [], // nggak diketahui → mapper nebak dari skillLevelMap
        proudMap: {},
      });
      added++;
    }
    if (added) console.log(`[characterStore] +${added} karakter dari enka-store-extra.json (genshin-db)`);
  } catch {
    /* file opsional */
  }

  // koreksi store Enka yang salah (mis. Columbina tercatat Pyro padahal Hydro) — ditulis dump:gdb dari genshin-db
  try {
    const overrides = JSON.parse(await fs.readFile(OVERRIDES_FILE, "utf8")) as { avatarId: number; element?: string | null; nameEn?: string }[];
    let n = 0;
    for (const o of overrides) {
      const c = byId.get(o.avatarId);
      if (!c || !o.element || c.element === o.element) continue;
      byId.set(o.avatarId, { ...c, element: o.element });
      n++;
    }
    if (n) console.log(`[characterStore] ${n} koreksi elemen dari enka-store-overrides.json`);
  } catch {
    /* file opsional */
  }
  loaded = true;
}

/** Pastikan store sudah dimuat (idempotent). */
export function loadCharacterStore(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (!loadingPromise) loadingPromise = doLoad();
  return loadingPromise;
}

export function resolveCharacter(avatarId: number): ResolvedCharacter | null {
  return byId.get(avatarId) ?? null;
}

/** Cari karakter by key ("HuTao") — case-insensitive. */
export function resolveByKey(key: string): ResolvedCharacter | null {
  const k = key.toLowerCase();
  for (const c of byId.values()) if (c.key.toLowerCase() === k) return c;
  return null;
}

/** Cari karakter by key / nama Inggris / nama terlokalisasi (buat input CLI). */
export function findCharacterByQuery(q: string): ResolvedCharacter | null {
  const raw = q.trim().toLowerCase();
  const key = deriveKey(q).toLowerCase();
  const all = [...byId.values()];
  return (
    all.find((c) => c.key.toLowerCase() === key) ??
    all.find((c) => c.nameEn.toLowerCase() === raw || c.name.toLowerCase() === raw) ??
    all.find((c) => c.nameEn.toLowerCase().includes(raw) || c.name.toLowerCase().includes(raw)) ??
    null
  );
}

/** Resolve text hash apa pun dari loc.json. */
export function resolveText(hash: string | number | undefined): string | null {
  if (hash == null) return null;
  const h = String(hash);
  return locLang[h] || locEn[h] || null;
}

/**
 * Resolve nama (artifact set / senjata) dari hash. Sebagian entry (mis. Marechaussee
 * Hunter, Emblem of Severed Fate, Staff of Homa, Splendor of Tranquil Waters) dikirim
 * Enka dengan hash yang meleset -512 dari key loc.json — coba direct dulu, baru +512.
 */
export function resolveNameHash(hash: string | number | undefined): string | null {
  const direct = resolveText(hash);
  if (direct) return direct;
  if (hash == null) return null;
  const n = Number(hash);
  return Number.isFinite(n) ? resolveText(n + 512) : null;
}

/** @deprecated pakai resolveNameHash */
export const resolveSetName = resolveNameHash;

export function allResolved(): ResolvedCharacter[] {
  return [...byId.values()];
}
