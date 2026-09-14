import { promises as fs } from "node:fs";
import path from "node:path";
import { env } from "../env";
import { EnkaError, type EnkaResponse } from "./enka.types";

const UID_RE = /^[1-9]\d{8,9}$/;

const CACHE_DIR = process.env.ENKA_STORE_CACHE_DIR ?? path.resolve(".cache/enka");

/**
 * Fixture offline (test/snapshot): kalau `ENKA_FIXTURE_DIR` diset dan ada `uid-<uid>.json` di sana,
 * dipakai apa adanya tanpa nyentuh jaringan/cache. Dibaca saat dipanggil (bukan saat import) biar test
 * bisa set env sebelum manggil.
 */
async function readFixture(uid: string): Promise<CachedProfile | null> {
  const dir = process.env.ENKA_FIXTURE_DIR;
  if (!dir) return null;
  try {
    const full = path.join(dir, `uid-${uid}.json`);
    const [stat, text] = await Promise.all([fs.stat(full), fs.readFile(full, "utf8")]);
    return { data: JSON.parse(text) as EnkaResponse, fetchedAt: new Date(stat.mtimeMs) };
  } catch {
    return null;
  }
}

export function isValidUid(uid: string): boolean {
  return UID_RE.test(uid.trim());
}

interface FetchResult {
  data: EnkaResponse;
  cached: boolean;
  fetchedAt: Date;
  /** detik tersisa sebelum boleh refetch UID yang sama */
  cooldownSeconds: number;
}

interface CachedProfile {
  data: EnkaResponse;
  fetchedAt: Date;
}

function cacheFile(uid: string): string {
  return path.join(CACHE_DIR, `uid-${uid}.json`);
}

async function readUidCache(uid: string): Promise<CachedProfile | null> {
  try {
    const full = cacheFile(uid);
    const [stat, text] = await Promise.all([fs.stat(full), fs.readFile(full, "utf8")]);
    return { data: JSON.parse(text) as EnkaResponse, fetchedAt: new Date(stat.mtimeMs) };
  } catch {
    return null;
  }
}

async function writeUidCache(uid: string, data: EnkaResponse): Promise<void> {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(cacheFile(uid), JSON.stringify(data), "utf8");
  } catch (err) {
    console.warn(`[enka] gagal nulis cache ${uid}: ${(err as Error).message}`);
  }
}

/**
 * Ambil showcase Enka untuk sebuah UID, dengan cache file di `.cache/enka/uid-<uid>.json`.
 * Cache menghormati cooldown ~60s Enka per-UID (default TTL 90s).
 */
export async function fetchEnkaProfile(rawUid: string): Promise<FetchResult> {
  const uid = rawUid.trim();
  if (!isValidUid(uid)) {
    throw new EnkaError("INVALID_UID", `UID tidak valid: "${uid}"`, 400);
  }

  const fixture = await readFixture(uid);
  if (fixture) return { data: fixture.data, cached: true, fetchedAt: fixture.fetchedAt, cooldownSeconds: 0 };

  const ttlMs = env.enka.cacheTtlSeconds * 1000;
  const cached = await readUidCache(uid);
  if (cached) {
    const ageMs = Date.now() - cached.fetchedAt.getTime();
    if (ageMs < ttlMs) {
      return {
        data: cached.data,
        cached: true,
        fetchedAt: cached.fetchedAt,
        cooldownSeconds: Math.ceil((ttlMs - ageMs) / 1000),
      };
    }
  }

  const url = `${env.enka.baseUrl}/api/uid/${uid}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": env.enka.userAgent, Accept: "application/json" },
    });
  } catch (err) {
    // network gagal -> pakai cache lama kalau ada
    if (cached) return staleFallback(cached.data, cached.fetchedAt);
    throw new EnkaError("UPSTREAM_ERROR", `Gagal menghubungi Enka: ${(err as Error).message}`);
  }

  if (res.status === 400) {
    throw new EnkaError("INVALID_UID", "Enka menolak UID ini (format salah).", 400);
  }
  if (res.status === 404) {
    throw new EnkaError("NOT_FOUND", "UID tidak ditemukan di Enka.", 404);
  }
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after") ?? 60);
    if (cached) return staleFallback(cached.data, cached.fetchedAt, retryAfter);
    throw new EnkaError(
      "RATE_LIMITED",
      `Kena rate limit Enka. Coba lagi dalam ${retryAfter} detik.`,
      429,
      retryAfter,
    );
  }
  if (res.status === 424 || res.status === 503) {
    throw new EnkaError("MAINTENANCE", "Game / Enka sedang maintenance.", 503);
  }
  if (!res.ok) {
    if (cached) return staleFallback(cached.data, cached.fetchedAt);
    throw new EnkaError("UPSTREAM_ERROR", `Enka error HTTP ${res.status}.`);
  }

  const data = (await res.json()) as EnkaResponse;
  const fetchedAt = new Date();
  await writeUidCache(uid, data);

  const ttl = data.ttl && data.ttl > 0 ? data.ttl : env.enka.cacheTtlSeconds;

  if (!data.avatarInfoList || data.avatarInfoList.length === 0) {
    throw new EnkaError(
      "SHOWCASE_EMPTY",
      "Showcase karakter kosong. Pin minimal 1 karakter di Character Showcase " +
        "(in-game: menu profile) lalu refresh. Pastikan juga privasi 'Show Character Details' aktif. " +
        "Kalau tetap kosong, pakai input manual.",
      422,
    );
  }

  return { data, cached: false, fetchedAt, cooldownSeconds: ttl };
}

function staleFallback(
  data: EnkaResponse,
  fetchedAt: Date,
  cooldownSeconds = 60,
): FetchResult {
  return { data, cached: true, fetchedAt, cooldownSeconds };
}
