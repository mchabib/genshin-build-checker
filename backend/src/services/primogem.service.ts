import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Kalkulator income primogem: dari tanggal A sampai tanggal B dapat berapa primo/fate → berapa wish.
 * Semua angka dari `scrape-data/Primogems/_sources.json` (data tangan, lihat _README.md di sana);
 * di sini cuma aritmetika tanggal. Murni offline, nggak nyentuh Enka/LLM.
 *
 * Aturan: harian × jumlah hari · siklus = jumlah reset yang kelewat · per-patch di-prorate dari
 * overlap hari (biar nggak lonjak di batas patch) · one-off kalau tanggalnya masuk rentang.
 */

export interface PrimogemTier {
  label: string;
  primogems: number;
  fates?: number;
}
export interface CycleSource {
  label: string;
  resetDays: number[];
  maxPrimogems?: number;
  maxUnits?: number;
  unitLabel?: string;
  tiers?: Record<string, PrimogemTier>;
}
export interface PrimogemEvent {
  id: string;
  date: string;
  label: string;
  primogems: number;
  fates?: number;
  patch?: string;
}
export interface PrimogemSources {
  perWish: number;
  daily: Record<string, { label: string; perDay: number }>;
  welkin: { label: string; perDay: number; onPurchase: number; purchaseDays: number };
  stardust?: { label: string; resetDays: number[]; fates: number };
  battlePass: { label: string; maxLevel: number; levelsPerDay: number; tiers: Record<string, PrimogemTier> };
  cycles: Record<string, CycleSource>;
  patch: {
    cycleDays: number;
    anchor: { version: string; start: string };
    perPatch: Record<string, PrimogemTier>;
    eventsEstimate?: PrimogemTier;
  };
  events: PrimogemEvent[];
}

export class PrimogemError extends Error {
  constructor(
    public code: "no_data" | "bad_date" | "range_too_long",
    message: string,
  ) {
    super(message);
    this.name = "PrimogemError";
  }
}

const DATA_DIR = process.env.GAME_DATA_DIR ?? path.resolve("scrape-data");
const FILE = path.join(DATA_DIR, "Primogems", "_sources.json");
/** batas rentang biar nggak ada yang minta hitung 50 tahun */
export const MAX_DAYS = 730;

let sources: PrimogemSources | null = null;
let loading: Promise<void> | null = null;

async function doLoad(): Promise<void> {
  try {
    sources = JSON.parse(await fs.readFile(FILE, "utf8")) as PrimogemSources;
    console.log(`[primogem] loaded ${Object.keys(sources.cycles).length} siklus, patch anchor ${sources.patch.anchor.version}`);
  } catch (err) {
    console.warn(`[primogem] gagal baca ${FILE}: ${(err as Error).message}`);
    sources = null;
  }
}

export function loadPrimogemStore(): Promise<void> {
  if (sources) return Promise.resolve();
  if (!loading) loading = doLoad();
  return loading;
}
export const primogemSources = (): PrimogemSources | null => sources;

// ---------- tanggal (semua UTC biar bebas timezone) ----------
const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseDay(s: string, field: string): number {
  const v = String(s ?? "").trim();
  if (!DATE_RE.test(v)) throw new PrimogemError("bad_date", `${field} harus format YYYY-MM-DD (dapat "${s}")`);
  const ms = Date.parse(`${v}T00:00:00Z`);
  if (!Number.isFinite(ms)) throw new PrimogemError("bad_date", `${field} bukan tanggal valid: "${s}"`);
  return ms;
}
export const fmtDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
export const todayUtc = (): number => Math.floor(Date.now() / DAY_MS) * DAY_MS;

/** Jumlah reset harian yang kelewat di rentang (from, to]. */
const daysBetween = (from: number, to: number): number => Math.max(0, Math.round((to - from) / DAY_MS));

/** Berapa kali tanggal-tanggal `resetDays` kelewat di rentang (from, to]. */
export function countResets(from: number, to: number, resetDays: number[]): number {
  if (to <= from || !resetDays?.length) return 0;
  let n = 0;
  for (let d = from + DAY_MS; d <= to; d += DAY_MS) {
    if (resetDays.includes(new Date(d).getUTCDate())) n++;
  }
  return n;
}

/** Label versi berikutnya: 7.1 → 7.2 … 7.8 → 8.0. Cuma buat tampilan. */
export function nextVersion(v: string): string {
  const [maj, min] = v.split(".").map((x) => Number.parseInt(x, 10));
  if (!Number.isFinite(maj) || !Number.isFinite(min)) return v;
  return min >= 8 ? `${maj + 1}.0` : `${maj}.${min + 1}`;
}
/** Kebalikannya: 7.1 → 7.0, 7.0 → 6.8. */
export function prevVersion(v: string): string {
  const [maj, min] = v.split(".").map((x) => Number.parseInt(x, 10));
  if (!Number.isFinite(maj) || !Number.isFinite(min)) return v;
  return min <= 0 ? `${Math.max(1, maj - 1)}.8` : `${maj}.${min - 1}`;
}
function versionAt(base: string, steps: number): string {
  let v = base;
  for (let i = 0; i < steps; i++) v = nextVersion(v);
  for (let i = 0; i > steps; i--) v = prevVersion(v);
  return v;
}

export interface PatchWindow {
  version: string;
  start: string;
  end: string;
  /** hari patch ini yang masuk rentang */
  overlapDays: number;
}

/** Patch yang nabrak rentang [from, to), plus berapa hari overlap-nya. */
export function patchesInRange(from: number, to: number, patch: PrimogemSources["patch"]): PatchWindow[] {
  const cycleDays = Math.max(1, patch.cycleDays);
  const cycle = cycleDays * DAY_MS;
  const anchor = parseDay(patch.anchor.start, "patch.anchor.start");
  const first = Math.floor((from - anchor) / cycle);
  const out: PatchWindow[] = [];
  for (let i = first; out.length <= MAX_DAYS / cycleDays + 2; i++) {
    const start = anchor + i * cycle;
    if (start >= to) break;
    const end = start + cycle;
    const overlap = Math.min(end, to) - Math.max(start, from);
    if (overlap > 0)
      out.push({
        version: versionAt(patch.anchor.version, i),
        start: fmtDay(start),
        end: fmtDay(end),
        overlapDays: Math.round(overlap / DAY_MS),
      });
  }
  return out;
}

// ---------- perhitungan ----------
export interface PrimogemOptions {
  /** default: hari ini (UTC) */
  from?: string;
  /** wajib: tanggal target */
  to: string;
  welkin?: boolean;
  /** beli 5 Intertwined Fate di toko Stardust tiap reset bulanan */
  stardust?: boolean;
  /** key di `battlePass.tiers`: none | free | paid */
  battlePass?: string;
  /** level BP sekarang (0-50); sisa level dikejar `levelsPerDay` per hari */
  bpLevel?: number;
  /** 0-36 */
  abyssStars?: number;
  /** key di `cycles.theater.tiers` */
  theater?: string;
  /** key di `cycles.stygian.tiers` */
  stygian?: string;
  /** ikut event patch, kode livestream, kompensasi maintenance (default true) */
  events?: boolean;
  /** primo tambahan dari quest/eksplorasi, perkiraan sendiri */
  extraPrimogems?: number;
  /** ikut hitung event bertanggal (default true) */
  oneOff?: boolean;
  /** id event yang mau dilewati (mis. event yang kamu nggak ikut) */
  skipEvents?: string[];
  /** primo & fate yang SUDAH dipunya sekarang */
  currentPrimogems?: number;
  currentFates?: number;
}

export interface PrimogemRow {
  key: string;
  label: string;
  detail: string;
  primogems: number;
  fates: number;
}

export interface PrimogemReport {
  from: string;
  to: string;
  days: number;
  patches: PatchWindow[];
  /** total patch yang ke-cover (boleh pecahan) */
  patchFraction: number;
  rows: PrimogemRow[];
  totalPrimogems: number;
  totalFates: number;
  perWish: number;
  wishes: number;
  /** sisa primo yang nggak cukup jadi 1 wish */
  leftover: number;
  warnings: string[];
}

export async function planPrimogems(opts: PrimogemOptions): Promise<PrimogemReport> {
  await loadPrimogemStore();
  const s = sources;
  if (!s) throw new PrimogemError("no_data", "scrape-data/Primogems/_sources.json nggak ada / rusak.");

  const from = opts.from ? parseDay(opts.from, "from") : todayUtc();
  const to = parseDay(opts.to, "to");
  if (to < from)
    throw new PrimogemError("bad_date", `tanggal target (${fmtDay(to)}) lebih awal dari tanggal mulai (${fmtDay(from)})`);
  const days = daysBetween(from, to);
  if (days > MAX_DAYS) throw new PrimogemError("range_too_long", `rentang ${days} hari kepanjangan (maks ${MAX_DAYS} hari)`);

  const warnings: string[] = [];
  const rows: PrimogemRow[] = [];
  const add = (key: string, label: string, detail: string, primogems: number, fates = 0) => {
    const p = Math.round(primogems);
    if (p || fates) rows.push({ key, label, detail, primogems: p, fates });
  };

  if (opts.currentPrimogems || opts.currentFates)
    add("current", "Punya sekarang", "saldo awal", opts.currentPrimogems ?? 0, opts.currentFates ?? 0);

  for (const [key, d] of Object.entries(s.daily))
    add(`daily.${key}`, d.label, `${d.perDay}/hari × ${days} hari`, d.perDay * days);

  if (opts.welkin) {
    const buys = Math.ceil(days / Math.max(1, s.welkin.purchaseDays));
    add(
      "welkin",
      s.welkin.label,
      `${s.welkin.perDay}/hari × ${days} hari + ${s.welkin.onPurchase} × ${buys} pembelian`,
      s.welkin.perDay * days + s.welkin.onPurchase * buys,
    );
  }

  const patches = patchesInRange(from, to, s.patch);
  const patchFraction = patches.reduce((a, p) => a + p.overlapDays, 0) / Math.max(1, s.patch.cycleDays);
  const pf = Math.round(patchFraction * 100) / 100;
  const patchLabel = patches.map((x) => x.version).join(", ") || "-";

  // battle pass: reset tiap patch, level naik `levelsPerDay`. Patch pertama cuma sisa level yang belum kekejar.
  const bpKey = opts.battlePass ?? "none";
  const bp = s.battlePass.tiers[bpKey];
  if (!bp) warnings.push(`battlePass "${bpKey}" nggak dikenal (pilih: ${Object.keys(s.battlePass.tiers).join(", ")})`);
  else if (bp.primogems || bp.fates) {
    const maxLevel = Math.max(1, s.battlePass.maxLevel || 50);
    const perDay = s.battlePass.levelsPerDay || 1.5;
    const startLevel = Math.max(0, Math.min(opts.bpLevel ?? 0, maxLevel));
    let units = 0;
    patches.forEach((p, i) => {
      const capacity = (p.overlapDays * perDay) / maxLevel; // seberapa banyak level yang muat di sisa hari
      const room = i === 0 ? (maxLevel - startLevel) / maxLevel : 1; // patch pertama: sisa level BP sekarang
      units += Math.max(0, Math.min(room, capacity));
    });
    const bpUnits = Math.round(units * 100) / 100;
    add(
      "battlePass",
      `${s.battlePass.label} — ${bp.label}`,
      `${bpUnits} BP (mulai level ${startLevel}, +${perDay}/hari)`,
      bp.primogems * units,
      Math.floor((bp.fates ?? 0) * units),
    );
  }

  // toko Stardust: 5 Intertwined Fate tiap reset bulanan
  if (opts.stardust && s.stardust) {
    const resets = countResets(from, to, s.stardust.resetDays);
    if (resets) add("stardust", s.stardust.label, `${s.stardust.fates} fate × ${resets} reset`, 0, s.stardust.fates * resets);
  }

  for (const [key, c] of Object.entries(s.cycles)) {
    const resets = countResets(from, to, c.resetDays);
    if (key === "abyss") {
      const maxUnits = c.maxUnits ?? 36;
      const stars = Math.max(0, Math.min(opts.abyssStars ?? 0, maxUnits));
      if (!stars || !resets) continue;
      const per = Math.round(((c.maxPrimogems ?? 0) * stars) / maxUnits);
      add(`cycle.${key}`, c.label, `${stars} ${c.unitLabel ?? "unit"} × ${resets} reset (${per}/reset)`, per * resets);
      continue;
    }
    const tierKey = (key === "theater" ? opts.theater : key === "stygian" ? opts.stygian : undefined) ?? "skip";
    const tier = c.tiers?.[tierKey];
    if (!tier) {
      if (tierKey !== "skip") warnings.push(`${key} "${tierKey}" nggak dikenal (pilih: ${Object.keys(c.tiers ?? {}).join(", ")})`);
      continue;
    }
    if (!tier.primogems || !resets) continue;
    add(`cycle.${key}`, `${c.label} — ${tier.label}`, `${tier.primogems} × ${resets} reset`, tier.primogems * resets);
  }

  if (opts.events !== false) {
    for (const [key, p] of Object.entries(s.patch.perPatch))
      add(`patch.${key}`, p.label, `${pf} patch (${patchLabel})`, p.primogems * patchFraction, Math.floor((p.fates ?? 0) * patchFraction));
  }

  // event bertanggal; patch yang belum punya daftar event pakai estimasi (prorate dari overlap)
  const skip = new Set(opts.skipEvents ?? []);
  if (opts.oneOff !== false) {
    for (const e of s.events ?? []) {
      if (skip.has(e.id)) continue;
      const d = parseDay(e.date, `event "${e.label}"`);
      if (d > from && d <= to) add(`event.${e.id}`, e.label, `${e.date}${e.patch ? ` · ${e.patch}` : ""}`, e.primogems, e.fates ?? 0);
    }
  }
  if (opts.events !== false && s.patch.eventsEstimate) {
    const est = s.patch.eventsEstimate;
    for (const p of patches) {
      const ps = parseDay(p.start, "patch.start");
      const pe = parseDay(p.end, "patch.end");
      const punya = (s.events ?? []).some((e) => {
        const d = parseDay(e.date, "event.date");
        return d >= ps && d < pe;
      });
      if (punya) continue;
      const frac = p.overlapDays / Math.max(1, s.patch.cycleDays);
      add(`patch.eventsEstimate.${p.version}`, `${est.label} ${p.version}`, `${Math.round(frac * 100) / 100} patch`, est.primogems * frac, Math.floor((est.fates ?? 0) * frac));
    }
  }

  if (opts.extraPrimogems) add("extra", "Quest & eksplorasi (manual)", "input kamu", opts.extraPrimogems);

  const totalPrimogems = rows.reduce((a, r) => a + r.primogems, 0);
  const totalFates = rows.reduce((a, r) => a + r.fates, 0);
  const perWish = s.perWish || 160;

  if (!days) warnings.push("rentangnya 0 hari — isi tanggal target yang lebih jauh");
  warnings.push(`jadwal patch ditebak dari anchor ${s.patch.anchor.version} (${s.patch.anchor.start}), siklus ${s.patch.cycleDays} hari — update di _sources.json kalau meleset`);

  return {
    from: fmtDay(from),
    to: fmtDay(to),
    days,
    patches,
    patchFraction: pf,
    rows,
    totalPrimogems,
    totalFates,
    perWish,
    wishes: Math.floor(totalPrimogems / perWish) + totalFates,
    leftover: totalPrimogems % perWish,
    warnings,
  };
}
