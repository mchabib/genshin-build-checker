import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Riwayat UID yang pernah dicek: siapa (nickname), berapa kali, kapan terakhir.
 * Disimpan sebagai 1 file JSON (`.data/uid-history.json`) — konsisten sama prinsip proyek: tanpa database.
 *
 * Privasi: data ini CUMA buat pemilik instance (endpoint `/api/history` butuh `ADMIN_TOKEN`).
 * Pengunjung nggak pernah lihat UID orang lain — riwayat di UI disimpan di browser masing-masing.
 *
 * Nulisnya di-debounce (default 5 detik) biar nggak bolak-balik nyentuh disk tiap request,
 * dan pakai tulis-ke-temp lalu rename biar file nggak korup kalau proses mati di tengah jalan.
 */

export interface UidHistoryEntry {
  uid: string;
  nickname: string | null;
  /** Adventure Rank terakhir yang kelihatan */
  level: number | null;
  /** berapa kali UID ini dicek */
  count: number;
  firstSeen: string;
  lastSeen: string;
}

export interface HistoryStats {
  entries: UidHistoryEntry[];
  totalUids: number;
  totalLookups: number;
  /** jumlah UID unik yang dicek dalam 24 jam terakhir */
  uidsLast24h: number;
  savedAt: string | null;
}

const DATA_DIR = process.env.HISTORY_DIR ?? path.resolve(".data");
const FILE = path.join(DATA_DIR, "uid-history.json");
const FLUSH_MS = Number(process.env.HISTORY_FLUSH_MS ?? 5000);
/** batas entri yang disimpan; yang paling lama nggak dipakai dibuang duluan */
const MAX_ENTRIES = Number(process.env.HISTORY_MAX ?? 5000);

let entries = new Map<string, UidHistoryEntry>();
let loaded = false;
let loading: Promise<void> | null = null;
let dirty = false;
let timer: NodeJS.Timeout | null = null;

async function doLoad(): Promise<void> {
  try {
    const raw = JSON.parse(await fs.readFile(FILE, "utf8")) as UidHistoryEntry[];
    entries = new Map(raw.filter((e) => e?.uid).map((e) => [e.uid, e]));
    console.log(`[history] loaded ${entries.size} UID`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT")
      console.warn(`[history] gagal baca ${FILE}: ${(err as Error).message}`);
    entries = new Map();
  }
  loaded = true;
}

export function loadHistory(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (!loading) loading = doLoad();
  return loading;
}

/**
 * Tulis ke disk sekarang juga (temp → rename, biar file nggak korup).
 * Flush di-antrekan: kalau timer dan pemanggilan manual barengan, nggak rebutan file temp.
 */
let flushChain: Promise<void> = Promise.resolve();
export function flushHistory(): Promise<void> {
  flushChain = flushChain.then(doFlush, doFlush);
  return flushChain;
}

async function doFlush(): Promise<void> {
  if (!dirty) return;
  dirty = false;
  const list = [...entries.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  const tmp = `${FILE}.${process.pid}.tmp`;
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(list), "utf8");
    await fs.rename(tmp, FILE);
  } catch (err) {
    console.warn(`[history] gagal nulis ${FILE}: ${(err as Error).message}`);
    dirty = true; // coba lagi di flush berikutnya
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

function scheduleFlush(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void flushHistory();
  }, FLUSH_MS);
  timer.unref?.();
}

/** Catat satu pengecekan UID. Aman dipanggil tanpa await (error nggak boleh ganggu request). */
export async function recordUid(uid: string, nickname: string | null, level: number | null): Promise<void> {
  if (!/^[1-9]\d{8,9}$/.test(uid)) return;
  await loadHistory();
  const now = new Date().toISOString();
  const cur = entries.get(uid);
  if (cur) {
    cur.count++;
    cur.lastSeen = now;
    if (nickname) cur.nickname = nickname;
    if (level != null) cur.level = level;
  } else {
    entries.set(uid, { uid, nickname, level, count: 1, firstSeen: now, lastSeen: now });
    // buang yang paling lama nggak kepakai kalau kebanyakan
    if (entries.size > MAX_ENTRIES) {
      const sorted = [...entries.values()].sort((a, b) => a.lastSeen.localeCompare(b.lastSeen));
      for (const e of sorted.slice(0, entries.size - MAX_ENTRIES)) entries.delete(e.uid);
    }
  }
  dirty = true;
  scheduleFlush();
}

export async function historyStats(opts: { limit?: number; sort?: "count" | "lastSeen" } = {}): Promise<HistoryStats> {
  await loadHistory();
  const all = [...entries.values()];
  const sort = opts.sort ?? "lastSeen";
  all.sort((a, b) => (sort === "count" ? b.count - a.count || b.lastSeen.localeCompare(a.lastSeen) : b.lastSeen.localeCompare(a.lastSeen)));
  const cutoff = new Date(Date.now() - 86_400_000).toISOString();
  let savedAt: string | null = null;
  try {
    savedAt = (await fs.stat(FILE)).mtime.toISOString();
  } catch {
    /* belum pernah ke-flush */
  }
  return {
    entries: all.slice(0, Math.max(1, Math.min(opts.limit ?? 100, 1000))),
    totalUids: all.length,
    totalLookups: all.reduce((a, e) => a + e.count, 0),
    uidsLast24h: all.filter((e) => e.lastSeen >= cutoff).length,
    savedAt,
  };
}

/** Hapus semua riwayat (buat admin). */
export async function clearHistory(): Promise<number> {
  await loadHistory();
  const n = entries.size;
  entries = new Map();
  dirty = true;
  await flushHistory();
  return n;
}
