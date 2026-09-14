import { promises as fs } from "node:fs";
import path from "node:path";
import type { Modifier, ReactionKey, HitKind } from "./damage.types";
import type { Element } from "../lib/stats";
import type { ActionLimits } from "../lib/kqmCombo";

/**
 * Buff terstruktur dari `scrape-data/Buffs/` — sumber data jalur TANPA LLM.
 * Lihat scrape-data/Buffs/_README.md buat format. Angka boleh ekspresi "= ..." yang
 * dievaluasi lewat `resolveModifier()` dengan konteks karakter/tim.
 */

export type BuffMode = "always" | "assume" | "manual";

/** Modifier mentah dari JSON: nilai boleh string ekspresi, record elemen boleh pakai "$self". */
export type RawModifier = Record<string, unknown>;

export interface RawBuffEntry {
  id: string;
  description: string;
  mode?: BuffMode;
  /** cuma kalau elemen karakter termasuk */
  onlyElements?: Element[];
  /** self: butuh constellation ≥ n; team: constellation teammate (kalau diketahui) */
  requireCon?: number;
  /** butuh elemen ini ada di tim (selain diri sendiri) */
  requireTeamElement?: Element;
  /** self: butuh 4pc set ini terpasang (nama set) */
  requireSet?: string;
  /**
   * Lama buff nyala (detik; angka atau ekspresi "= ..."). Kalau durasi rotasi diketahui, uptime
   * = min(1, duration / max(rotasi, cooldown)) — ngalahin `uptime` statis di `mod`.
   * Team entry dengan `fromCharacter`+`requiresAction` tanpa field ini: diambil otomatis dari label
   * "Duration"/"CD" talent teammate (tmeta).
   */
  duration?: number | string;
  cooldown?: number | string;
  mod: RawModifier;
}
export interface TeamBuffEntry extends RawBuffEntry {
  fromCharacter?: string;
  /** support yang bikin buff ini diasumsikan aktif (mis. VV kalau ada Kazuha) */
  assumeWith?: string[];
  /** resonance elemen: aktif kalau ≥2 karakter elemen itu di tim */
  resonance?: Element;
  /** di rotasi tim: buff ini cuma aktif kalau aksi ini (E/Q) teammate-nya muncul di urutan */
  requiresAction?: "skill" | "burst";
}
export interface SetBuffEntry extends RawBuffEntry {
  set: string;
}
export interface WeaponBuffEntry extends RawBuffEntry {
  weapon: string;
}
export interface CharacterModule {
  key: string;
  role?: "dps" | "subdps" | "support" | "shielder" | "healer" | "buffer";
  /** override elemen NA/CA/plunge (default: tabel infusions.ts / physical) */
  naElements?: Partial<Record<"na" | "ca" | "plunge", Element>>;
  self: RawBuffEntry[];
  /** override rule reaksi: elemen teammate yang ada → reaksi per jenis hit (urutan key = prioritas) */
  reactions?: { with: Record<string, Partial<Record<HitKind, ReactionKey | null>>> };
  /**
   * preset rotasi: `counts` (hit id → jumlah) ATAU `kqm` (notasi quickhand, mis. "E 8[N1C] Q").
   * `duration` (detik) wajib buat bentuk `counts` kalau mau DPS; bentuk `kqm` dihitung dari tabel durasi.
   */
  rotations?: { label: string; counts?: Record<string, number>; kqm?: string; note?: string; duration?: number }[];
  /** arti 1 aksi dalam hit: { "E": { "skill3": 5 }, "C": { "ca1": 1, "ca3": 4 }, "Q": {...} } */
  actions?: Record<string, Record<string, number>>;
  /** override durasi token notasi (detik), key sama dengan `actions`: { "E": 0.9, "Q": 2.5 } */
  durations?: Record<string, number>;
  /** batas aksi berurutan (lihat ActionLimits di lib/kqmCombo.ts): { "C": { "max": 2, "resetBy": ["E"], "overflow": {...} } } */
  limits?: ActionLimits;
  teams?: string[][];
}

/** `_durations.json`: "default" + per tipe senjata (lowercase) → token → detik */
export type DurationsFile = Record<string, Record<string, number>>;

/** `_benchmark.json`: standar build acuan (lihat komentar di file) */
export interface BenchmarkConfig {
  fixedRollsPerSubstat: number;
  liquidRolls: number;
  maxLiquidPerSubstatPerArtifact: number;
  critRatio: number;
  /** token KQM → nilai 1 roll (rata-rata 5★) */
  rollValue: Record<string, number>;
  /** token KQM → nilai main stat 5★ lv20 */
  mainStatValue: Record<string, number>;
  grade: { pass: number; warn: number };
}

const DATA_DIR = process.env.GAME_DATA_DIR ?? path.resolve("scrape-data");
const BUFF_DIR = path.join(DATA_DIR, "Buffs");

let team: TeamBuffEntry[] = [];
let sets: SetBuffEntry[] = [];
let weapons: WeaponBuffEntry[] = [];
let durations: DurationsFile = {};
let benchmark: BenchmarkConfig | null = null;
let modules = new Map<string, CharacterModule>();
let loaded = false;
let loadingPromise: Promise<void> | null = null;

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(path.join(BUFF_DIR, file), "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT")
      console.warn(`[buffStore] gagal baca ${file}: ${(err as Error).message}`);
    return fallback;
  }
}

async function doLoad(): Promise<void> {
  team = await readJson<TeamBuffEntry[]>("_team.json", []);
  sets = await readJson<SetBuffEntry[]>("_sets.json", []);
  weapons = await readJson<WeaponBuffEntry[]>("_weapons.json", []);
  durations = await readJson<DurationsFile>("_durations.json", {});
  benchmark = await readJson<BenchmarkConfig | null>("_benchmark.json", null);
  let files: string[] = [];
  try {
    files = (await fs.readdir(BUFF_DIR)).filter((f) => f.endsWith(".json") && !f.startsWith("_"));
  } catch {
    console.warn(`[buffStore] ${BUFF_DIR} nggak ada`);
  }
  const map = new Map<string, CharacterModule>();
  for (const f of files) {
    const m = await readJson<CharacterModule | null>(f, null);
    if (m?.key) map.set(m.key, { ...m, self: m.self ?? [] });
  }
  modules = map;
  loaded = true;
  console.log(`[buffStore] loaded ${team.length} buff tim, ${sets.length} set, ${weapons.length} senjata, ${map.size} modul karakter`);
}

export function loadBuffStore(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (!loadingPromise) loadingPromise = doLoad();
  return loadingPromise;
}

export const teamBuffs = () => team;
export const setBuffs = () => sets;
export const weaponBuffs = () => weapons;
export const getCharacterModule = (key: string): CharacterModule | null => modules.get(key) ?? null;
export const buffStoreStats = () => ({ loaded, team: team.length, sets: sets.length, weapons: weapons.length, modules: modules.size });

export const benchmarkConfig = (): BenchmarkConfig | null => benchmark;

/** Tabel durasi token buat satu karakter: default ← tipe senjata ← override modul. */
export function durationTableFor(weaponType: string | null | undefined, module?: CharacterModule | null): Record<string, number> {
  const wt = (weaponType ?? "").toLowerCase();
  const base = durations.default ?? {};
  const byWeapon = Object.entries(durations).find(([k]) => k !== "default" && !k.startsWith("_") && k.toLowerCase() === wt)?.[1] ?? {};
  return { ...base, ...byWeapon, ...(module?.durations ?? {}) };
}

// ---------- evaluator ekspresi ----------
export interface ExprContext {
  char: unknown;
  con: number;
  er: number;
  p: (slot: string, param: string) => number | undefined;
  tp: (key: string, slot: string, param: string) => number | undefined;
  tm: (key: string) => unknown;
  team: { keys: string[]; elements: string[]; count: number; sameElementCount: number };
  /** nilai ke-i efek senjata di refinement user (angka, ambil stack terakhir dari "12/24/40%") */
  wv: (i: number) => number;
  /** durasi/CD talent karakter sendiri (label "Duration"/"CD"), slot normal|skill|burst */
  meta: (slot: string) => { duration?: number; cd?: number };
  /** durasi/CD talent teammate */
  tmeta: (key: string, slot: string) => { duration?: number; cd?: number };
}

const ARG_NAMES = ["char", "con", "er", "p", "tp", "tm", "team", "wv", "min", "max", "round", "pct", "meta", "tmeta"] as const;
const compiled = new Map<string, (...args: unknown[]) => unknown>();

export function evalExpr(expr: string, ctx: ExprContext): unknown {
  const body = expr.replace(/^=\s*/, "");
  let fn = compiled.get(body);
  if (!fn) {
    // data lokal tepercaya (file di repo), bukan input user/LLM
    fn = new Function(...ARG_NAMES, `"use strict"; return (${body});`) as (...args: unknown[]) => unknown;
    compiled.set(body, fn);
  }
  return fn(ctx.char, ctx.con, ctx.er, ctx.p, ctx.tp, ctx.tm, ctx.team, ctx.wv, Math.min, Math.max, Math.round, (x: number) => x * 100, ctx.meta, ctx.tmeta);
}

/** Angka atau ekspresi "= ..." → detik (undefined kalau bukan angka valid). */
export function resolveSeconds(v: number | string | undefined, ctx: ExprContext): number | undefined {
  if (v == null) return undefined;
  const n = typeof v === "number" ? v : isExpr(v) ? evalExpr(v, ctx) : Number.parseFloat(v);
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
}

const isExpr = (v: unknown): v is string => typeof v === "string" && v.trimStart().startsWith("=");

function resolveValue(v: unknown, ctx: ExprContext, selfElement: string): unknown {
  if (isExpr(v)) return evalExpr(v, ctx);
  if (Array.isArray(v)) return v.map((x) => resolveValue(x, ctx, selfElement));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      out[k === "$self" ? selfElement : k] = resolveValue(x, ctx, selfElement);
    }
    return out;
  }
  return v;
}

/** RawModifier (JSON) → Modifier siap pakai. Field numerik yang hasilnya bukan angka dibuang. */
export function resolveModifier(id: string, raw: RawModifier, ctx: ExprContext, selfElement: string): Modifier {
  const r = resolveValue(raw, ctx, selfElement) as Record<string, unknown>;
  const out: Record<string, unknown> = { id };
  for (const [k, v] of Object.entries(r)) {
    if (v == null) continue;
    if (typeof v === "number" && (!Number.isFinite(v) || (v === 0 && k !== "uptime"))) continue;
    out[k] = v;
  }
  if (typeof out.source !== "string") out.source = id;
  if (out.scope == null) out.scope = "all";
  return out as unknown as Modifier;
}

/** "12/24/40%" → 40 ; "0.8%" → 0.8 ; "1270" → 1270 */
export function parseWeaponValue(s: string | undefined): number {
  if (!s) return 0;
  const last = s.split("/").pop() ?? s;
  const n = Number.parseFloat(last.replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}
