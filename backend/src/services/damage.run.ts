import { loadCharacterStore, findCharacterByQuery, resolveByKey } from "./characterStore";
import { getGuide, loadGuideStore } from "./guideStore";
import { getTalentData, getWeapon, loadGameDataStore, normalizeName, type StoredTalentData } from "./gameDataStore";
import { durationTableFor, getCharacterModule, loadBuffStore, parseWeaponValue, type CharacterModule } from "./buffStore";
import { fetchEnkaProfile, isValidUid } from "./enka.service";
import { EnkaError } from "./enka.types";
import { effectiveTalentLevels, mapShowcase, type ShowcaseCharacter } from "./enka.mapper";
import { CheckError } from "./check.service";
import { multiplierAt, parseTalentHits, parseTalentMeta } from "../lib/talentLabel";
import { applyTalentOverrides } from "../data/talentOverrides";
import { defaultNaElement } from "../data/infusions";
import { allEntriesFor, catalogById, type CatalogCtx, type CatalogEntry, type TeamCtx, type TeammateInfo } from "../data/buffCatalog";
import { computeRotation, computeTalentTable, defaultEnemy, isTransformative, resolveStats, type DamageCharacter, type DamageInput } from "./damage.service";
import type { Element } from "../lib/stats";
import { isLlmConfigured, LlmError, type ChatUsage, type LlmOptions } from "./llm.client";
import { buildDamagePrompt, suggestDamageWithLlm, type DamagePromptCtx, type LlmDamageSuggestion } from "./damage.llm";
import { inferReactions, pickRotation, pickTeam, teamElements } from "./damage.rules";
import { comboDuration, parseKqmCombo } from "../lib/kqmCombo";
import {
  TRANSFORMATIVE,
  AMPLIFYING,
  ADDITIVE,
  type DamageTable,
  type EnemyConfig,
  type HitDef,
  type HitKind,
  type LunarContributor,
  type Modifier,
  type ReactionKey,
  type Rotation,
  type RotationTiming,
  type TalentSlot,
} from "./damage.types";

/**
 * Orkestrasi kalkulator damage. Dua jalur buat keputusan (tim / buff kondisional / reaksi / rotasi):
 *   - "offline" (default): rule + data JSON (`scrape-data/Buffs`, guide KQM) — tanpa AI sama sekali.
 *   - "llm": LLM nyuplai keputusan (butuh LLM_API_KEY dan `llm: true`).
 * Angka SELALU dari kode (`damage.service.ts`), apa pun jalurnya.
 */

export class DamageError extends Error {
  constructor(
    public code: "no_talent_data" | "no_hits" | "bad_reaction" | "bad_team",
    message: string,
  ) {
    super(message);
    this.name = "DamageError";
  }
}

export interface DamageOptions {
  /** query nama/key teammate (max 3) */
  team?: string[];
  /** "vaporize" (semua kind yang cocok) atau "ca=vaporize,na=vaporize,burst=none" */
  reaction?: string;
  enemyLevel?: number;
  /** RES musuh semua elemen, persen */
  enemyResPct?: number;
  /** id katalog yang dipaksa aktif */
  catalogIds?: string[];
  /** modifier tambahan (API body) */
  extraModifiers?: Modifier[];
  /** rotasi: `counts` hitId -> jumlah (atau "react:<reaksi>"), ATAU `kqm` notasi ("E 9[N1C] Q") */
  rotation?: { label: string; counts?: Record<string, number>; kqm?: string } | null;
  /** durasi rotasi (detik) dipaksa — buat rotasi `counts` yang nggak bisa dihitung dari notasi */
  duration?: number;
  /**
   * Jendela waktu buat uptime buff (detik). Default = durasi rotasi karakter ini; rotasi TIM ngirim
   * durasi seluruh tim (Bennett Q 12s dari rotasi tim 21s, bukan dari segmen 5s).
   */
  buffWindow?: number;
  /**
   * Rotasi tim: aksi teammate yang muncul di urutan (key -> ["skill","burst"]). Kalau diisi, buff tim
   * dengan `requiresAction` cuma aktif kalau aksinya ada.
   */
  teamActions?: Record<string, ("skill" | "burst")[]>;
  /** override elemen NA/CA/plunge */
  naInfusion?: Element | null;
  /** hit Cryo/Electro terekam Polestar Field per 4s → koefisien Stellar-Conduct (default 8 ≈ ×1.8) */
  stellarHits?: number;
  /** pakai LLM? default: false (offline). true butuh LLM_API_KEY. */
  llm?: boolean;
  llmOptions?: LlmOptions;
  /** offline: JANGAN asumsikan buff kondisional (mode "assume") — cuma yang pasti aktif */
  noAssume?: boolean;
  /** sertakan prompt LLM di report.context.prompt (debug) */
  dumpPrompt?: boolean;
  /** ganti data karakter showcase (benchmark: build acuan dengan artifact standar) */
  showcaseOverride?: ShowcaseCharacter;
}

export interface LlmReportInfo {
  used: boolean;
  model: string | null;
  cached: boolean;
  attempts: number;
  usage?: ChatUsage;
  teamReason: string;
  notes: string[];
  verdict: string;
  warnings: string[];
  error: string | null;
}

export interface AppliedModifier extends Modifier {
  origin: "self" | "assume" | "team" | "catalog" | "custom" | "llm";
  /** dari mana `uptime`-nya: statis di JSON, dihitung dari durasi buff vs rotasi, atau LLM */
  uptimeSource?: "static" | "duration" | "llm";
  duration?: number;
  cooldown?: number;
}

export type TeamSource = "flag" | "llm" | "module" | "kqm" | "none";
type RotationSource = "flag" | "llm" | "module" | "kqm" | "generic";
interface RotationSpec {
  label: string;
  counts: Record<string, number>;
  note?: string;
  source: RotationSource;
  kqm?: string;
  repeat?: number;
  duration?: number;
}

/**
 * Durasi rotasi: `--duration` → `rotations[].duration` modul → hitung dari notasi × tabel durasi
 * (`_durations.json` per tipe senjata + `durations` modul).
 */
export function rotationTimingFor(
  spec: Pick<RotationSpec, "kqm" | "repeat" | "duration">,
  hits: HitDef[],
  module: CharacterModule | null,
  weaponType: string | null | undefined,
  flagDuration?: number,
): RotationTiming {
  const empty: RotationTiming = { duration: null, dps: null, source: null, rows: [], unknown: [] };
  if (flagDuration && flagDuration > 0) return { ...empty, duration: flagDuration, source: "flag" };
  if (spec.duration && spec.duration > 0) return { ...empty, duration: spec.duration, source: "module" };
  if (!spec.kqm) return empty;
  const p = parseKqmCombo(spec.kqm, hits, module?.actions ?? {}, module?.limits ?? {});
  const d = comboDuration(p.timeline, durationTableFor(weaponType, module));
  const repeat = spec.repeat && spec.repeat > 1 ? spec.repeat : 1;
  if (!d.total) return { ...empty, unknown: d.unknown };
  return {
    duration: Math.round(d.total * repeat * 100) / 100,
    dps: null,
    source: "notation",
    rows: d.rows.map((r) => ({ ...r, n: r.n * repeat, subtotal: Math.round(r.subtotal * repeat * 100) / 100 })),
    unknown: d.unknown,
  };
}

/** Durasi satu segmen notasi buat karakter showcase (butuh store sudah di-load). null kalau nggak ada data talent. */
export function notationTiming(sc: ShowcaseCharacter, notation: string): RotationTiming | null {
  if (!sc.key) return null;
  const td = getTalentData(sc.key);
  if (!td) return null;
  const { hits } = buildHits(sc.key, td);
  return rotationTimingFor({ kqm: notation }, hits, getCharacterModule(sc.key), sc.weaponType);
}

/**
 * Uptime nyata: kalau durasi buff diketahui dan ada jendela rotasi → uptime = min(1, durasi / max(jendela, CD)).
 * `uptime` statis di JSON (kalau ada) dianggap "efektivitas rata-rata SAAT aktif" (Furina Fanfare 0.8, Lost Prayer
 * 3/4 stack) dan dikalikan. Balikin catatan kalau CD lebih panjang dari rotasi.
 */
function applyTiming(e: CatalogEntry, m: AppliedModifier, ctx: CatalogCtx, window: number | undefined, notes: string[]): AppliedModifier {
  const t = e.timing(ctx);
  const out: AppliedModifier = { ...m, uptimeSource: m.uptime != null ? "static" : undefined };
  if (!t) return out;
  if (t.duration != null) out.duration = t.duration;
  if (t.cooldown != null) out.cooldown = t.cooldown;
  if (!window || t.duration == null) return out;
  const cycle = Math.max(window, t.cooldown ?? 0);
  const ratio = Math.min(1, t.duration / cycle);
  const eff = m.uptime ?? 1;
  const uptime = Math.round(eff * ratio * 1000) / 1000;
  out.uptime = uptime;
  out.uptimeSource = "duration";
  const src = t.source === "talent" ? " (dari talent)" : "";
  out.note = `${m.note ? `${m.note}; ` : ""}uptime ${uptime} = ${eff !== 1 ? `${eff} × ` : ""}${t.duration}s / ${cycle}s${src}`;
  if (t.cooldown != null && t.cooldown > window)
    notes.push(`${m.source}: CD ${t.cooldown}s > rotasi ${window}s — nggak bisa tiap rotasi, uptime dihitung per ${cycle}s`);
  return out;
}

export interface DamageReport {
  uid: string;
  fetchedAt: string;
  cached: boolean;
  mode: "offline" | "llm";
  character: {
    key: string;
    name: string;
    element: Element;
    weaponType: string | null;
    level: number;
    ascension: number | null;
    constellation: number;
    talentLevels: Record<TalentSlot, number>;
    weapon: ShowcaseCharacter["weapon"];
    sets: ShowcaseCharacter["sets"];
    naElements: Record<"na" | "ca" | "plunge", Element>;
    role: string | null;
    hasModule: boolean;
  };
  enemy: EnemyConfig;
  team: { members: { key: string; name: string; element: string | null; inShowcase: boolean }[]; source: TeamSource; reason: string };
  reactions: Partial<Record<HitKind, ReactionKey | null>>;
  reactionReason: string;
  modifiers: AppliedModifier[];
  baseline: DamageTable;
  buffed: DamageTable;
  rotation: (Rotation & { source: RotationSource; note?: string }) | null;
  llm: LlmReportInfo | null;
  warnings: string[];
  context: {
    showcase: ShowcaseCharacter;
    talentData: StoredTalentData;
    hits: HitDef[];
    prompt?: { system: string; user: string };
  };
}

const KINDS: HitKind[] = ["na", "ca", "plunge", "skill", "burst"];
const ALL_REACTIONS: ReactionKey[] = [...AMPLIFYING, ...ADDITIVE, ...TRANSFORMATIVE];

/** "vaporize" | "ca=vaporize,na=vaporize,burst=none" → per kind */
export function parseReactionFlag(flag: string | undefined): Partial<Record<HitKind, ReactionKey | null>> {
  if (!flag) return {};
  const out: Partial<Record<HitKind, ReactionKey | null>> = {};
  const norm = (s: string) => s.trim().replace(/[-_\s]/g, "").toLowerCase();
  const find = (s: string): ReactionKey | null => {
    if (norm(s) === "none" || norm(s) === "") return null;
    const r = ALL_REACTIONS.find((k) => k.toLowerCase() === norm(s));
    if (!r) throw new DamageError("bad_reaction", `reaksi "${s}" nggak dikenal (${ALL_REACTIONS.join(", ")})`);
    return r;
  };
  if (!flag.includes("=")) {
    const r = find(flag);
    for (const k of KINDS) out[k] = r;
    return out;
  }
  for (const part of flag.split(",")) {
    const [k, v] = part.split("=");
    const kind = KINDS.find((x) => x === k.trim().toLowerCase());
    if (!kind) throw new DamageError("bad_reaction", `jenis hit "${k}" nggak dikenal (${KINDS.join(", ")})`);
    out[kind] = find(v ?? "");
  }
  return out;
}

/** `--rotation` / `?rotation=`: "na1=9,ca1=9" (hit id → jumlah) ATAU notasi KQM "E 9[N1C] Q". */
export function parseRotationParam(raw: string | undefined): DamageOptions["rotation"] {
  if (!raw?.trim()) return null;
  if (!raw.includes("=")) return { label: "manual", kqm: raw.trim() };
  const counts: Record<string, number> = {};
  for (const p of raw.split(",")) {
    const [id, n] = p.split("=");
    if (id.trim()) counts[id.trim()] = Number(n ?? 1);
  }
  return { label: "manual", counts };
}

export function findInShowcase(showcase: ShowcaseCharacter[], query: string): ShowcaseCharacter | null {
  const want = query.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  const exact = showcase.find(
    (c) => (c.key ?? "").toLowerCase() === want || c.name.replace(/[^A-Za-z0-9]/g, "").toLowerCase() === want,
  );
  if (exact) return exact;
  const resolved = findCharacterByQuery(query);
  return resolved ? showcase.find((c) => c.key === resolved.key) ?? null : null;
}

export function buildHits(key: string | null, td: StoredTalentData): { hits: HitDef[]; warnings: string[] } {
  const warnings: string[] = [];
  const hits: HitDef[] = [];
  for (const slot of ["normal", "skill", "burst"] as TalentSlot[]) {
    const t = td.talents[slot];
    if (!t) continue;
    const r = parseTalentHits(slot, t.attributes);
    hits.push(...r.hits);
    for (const w of r.warnings) warnings.push(`${slot}: "${w.label}" di-skip (${w.reason})`);
  }
  return { hits: applyTalentOverrides(key, hits), warnings };
}

export function toDamageCharacter(
  sc: ShowcaseCharacter,
  naInfusion?: Element | null,
  moduleNa?: Partial<Record<"na" | "ca" | "plunge", Element>>,
): DamageCharacter {
  const element = (sc.element ?? "physical").toLowerCase() as Element;
  const lv = effectiveTalentLevels(sc.talents) ?? { normal: 1, skill: 1, burst: 1 };
  const na = (kind: "na" | "ca" | "plunge") =>
    naInfusion ?? moduleNa?.[kind] ?? defaultNaElement(sc.key, element, sc.weaponType, kind);
  return {
    key: sc.key,
    level: sc.level ?? 90,
    element,
    naElements: { na: na("na"), ca: na("ca"), plunge: na("plunge") },
    talentLevels: lv,
    final: {
      hp: sc.finalStats.hp,
      atk: sc.finalStats.atk,
      def: sc.finalStats.def,
      em: sc.stats.elementalMastery,
      critRate: sc.stats.critRate,
      critDmg: sc.stats.critDmg,
    },
    base: sc.baseStats,
    dmgBonus: sc.dmgBonus,
  };
}

function teammateInfo(sc: ShowcaseCharacter): TeammateInfo {
  return {
    key: sc.key ?? "",
    baseAtk: sc.baseStats.atk || null,
    atk: sc.finalStats.atk || null,
    hp: sc.finalStats.hp || null,
    def: sc.finalStats.def || null,
    em: sc.stats.elementalMastery,
    con: sc.constellation,
    constellation: sc.constellation,
    talentLevels: effectiveTalentLevels(sc.talents),
  };
}

export function makeCatalogCtx(
  char: DamageCharacter,
  sc: ShowcaseCharacter,
  td: StoredTalentData,
  showcase: ShowcaseCharacter[],
  team: TeamCtx,
): CatalogCtx {
  const paramAt = (data: StoredTalentData | null, slot: TalentSlot, param: string, level: number) => {
    const values = data?.talents[slot]?.attributes.parameters[param];
    return values?.length ? multiplierAt(values, level) : undefined;
  };
  const weapon = getWeapon(sc.weapon?.name);
  const refine = `r${Math.min(Math.max(sc.weapon?.refinement ?? 1, 1), 5)}`;
  const wvals = weapon?.refinements[refine]?.values ?? weapon?.refinements.r1?.values ?? [];
  return {
    char,
    key: sc.key!,
    constellation: sc.constellation,
    er: sc.stats.energyRecharge,
    team,
    sets4: sc.sets.filter((s) => s.count >= 4).map((s) => normalizeName(s.name)),
    talentParam: (slot, param) => paramAt(td, slot, param, char.talentLevels[slot]),
    teammate: (k) => {
      const t = showcase.find((c) => c.key === k);
      return t ? teammateInfo(t) : null;
    },
    teammateParam: (k, slot, param) => {
      const t = showcase.find((c) => c.key === k);
      const lvl = effectiveTalentLevels(t?.talents ?? null)?.[slot] ?? 10;
      return paramAt(getTalentData(k), slot, param, lvl);
    },
    weaponValue: (i) => parseWeaponValue(wvals[i]),
    talentMeta: (slot) => parseTalentMeta(td.talents[slot]?.attributes, char.talentLevels[slot]),
    teammateMeta: (k, slot) => {
      const t = showcase.find((c) => c.key === k);
      const lvl = effectiveTalentLevels(t?.talents ?? null)?.[slot] ?? 10;
      return parseTalentMeta(getTalentData(k)?.talents[slot]?.attributes, lvl);
    },
  };
}

function entryMatchesSelf(e: CatalogEntry, ctx: CatalogCtx, sc: ShowcaseCharacter): boolean {
  if (e.forCharacter) return e.forCharacter === ctx.key;
  if (e.forSet) return sc.sets.some((s) => s.count >= 4 && normalizeName(s.name) === normalizeName(e.forSet!));
  if (e.forWeapon) return !!sc.weapon?.name && normalizeName(sc.weapon.name) === normalizeName(e.forWeapon);
  return false;
}

/**
 * Self-buff: `always` selalu; `assume` kalau `assume=true` (offline "asumsi max"); `manual` cuma via forceIds.
 * Origin dibedain biar kelihatan mana yang asumsi.
 */
export function selfModifiers(
  ctx: CatalogCtx,
  sc: ShowcaseCharacter,
  forceIds: Set<string>,
  assume: boolean,
  window?: number,
  notes: string[] = [],
): AppliedModifier[] {
  const out: AppliedModifier[] = [];
  for (const e of allEntriesFor(ctx.key)) {
    if (e.kind !== "self" || !entryMatchesSelf(e, ctx, sc)) continue;
    const forced = forceIds.has(e.id);
    if (e.mode === "manual" && !forced) continue;
    if (e.mode === "assume" && !assume && !forced) continue;
    const m = e.build(ctx);
    if (m)
      out.push(
        applyTiming(e, { ...m, origin: e.mode === "assume" && !forced ? "assume" : forced && e.mode !== "always" ? "catalog" : "self" }, ctx, window, notes),
      );
  }
  return out;
}

/** Buff tim: fromCharacter ∈ tim selalu; assumeWith/resonance kalau `assume`; sisanya via forceIds. */
export function teamModifiers(
  ctx: CatalogCtx,
  teamKeys: string[],
  teamElementsAll: string[],
  forceIds: Set<string>,
  assume: boolean,
  teamActions?: Record<string, ("skill" | "burst")[]>,
  skipped?: string[],
  window?: number,
  notes: string[] = [],
): AppliedModifier[] {
  const out: AppliedModifier[] = [];
  const elemCount = (el: string) => teamElementsAll.filter((e) => e === el).length;
  for (const e of allEntriesFor(ctx.key)) {
    if (e.kind !== "team") continue;
    const forced = forceIds.has(e.id);
    // team entry `mode: manual` = jangan otomatis walau fromCharacter ada di tim (cuma via --catalog / LLM)
    if (e.mode === "manual" && !forced) continue;
    let auto = !!e.fromCharacter && teamKeys.includes(e.fromCharacter);
    // rotasi tim: buff support cuma nyala kalau aksinya beneran ada di urutan
    if (auto && teamActions && e.requiresAction && e.fromCharacter && !forced) {
      const seen = teamActions[e.fromCharacter] ?? [];
      if (!seen.includes(e.requiresAction)) {
        skipped?.push(`${e.source ?? e.id}: ${e.fromCharacter} nggak pakai ${e.requiresAction === "burst" ? "Q" : "E"} di rotasi`);
        auto = false;
      }
    }
    const assumed =
      assume &&
      ((e.assumeWith?.some((k) => teamKeys.includes(k)) ?? false) || (!!e.resonance && elemCount(e.resonance) >= 2));
    if (!auto && !assumed && !forced) continue;
    const m = e.build(ctx);
    if (m) out.push(applyTiming(e, { ...m, origin: auto ? "team" : assumed && !forced ? "assume" : "catalog" }, ctx, window, notes));
  }
  return out;
}

export async function runDamage(rawUid: string, characterQuery: string, opts: DamageOptions = {}): Promise<DamageReport> {
  const uid = rawUid.trim();
  if (!isValidUid(uid)) throw new EnkaError("INVALID_UID", `UID tidak valid: "${uid}"`, 400);
  await Promise.all([loadCharacterStore(), loadGuideStore(), loadGameDataStore(), loadBuffStore()]);

  const profile = await fetchEnkaProfile(uid);
  const showcase = mapShowcase(profile.data);
  const found = findInShowcase(showcase, characterQuery);
  if (!found || !found.key)
    throw new CheckError("not_in_showcase", `"${characterQuery}" nggak ada di showcase UID ${uid}. Pin dulu di Character Showcase in-game.`);
  const sc: ShowcaseCharacter & { key: string } = (opts.showcaseOverride ?? found) as ShowcaseCharacter & { key: string };

  const td = getTalentData(sc.key);
  if (!td) throw new DamageError("no_talent_data", `${sc.name} belum ada data talent (jalankan npm run dump:gdb).`);

  const warnings: string[] = [];
  const { hits, warnings: hitWarnings } = buildHits(sc.key, td);
  warnings.push(...hitWarnings);
  if (!hits.length) throw new DamageError("no_hits", `${sc.name}: nggak ada hit yang bisa diparse dari data talent.`);

  const module: CharacterModule | null = getCharacterModule(sc.key);
  const guide = getGuide(sc.key);
  const wantLlm = (opts.llm ?? false) && isLlmConfigured();
  if (opts.llm && !isLlmConfigured()) warnings.push("LLM diminta tapi LLM_API_KEY kosong — pakai jalur offline");
  const mode: DamageReport["mode"] = wantLlm ? "llm" : "offline";
  const assume = mode === "offline" && !opts.noAssume;

  let char = toDamageCharacter(sc, opts.naInfusion, module?.naElements);
  const forceIds = new Set(opts.catalogIds ?? []);
  for (const id of forceIds) if (!catalogById(id, sc.key)) warnings.push(`catalog id "${id}" nggak dikenal`);

  // ---- tim ----
  const resolveKey = (q: string) => findCharacterByQuery(q)?.key ?? null;
  const toMembers = (keys: string[]) =>
    keys.map((k) => {
      const c = resolveByKey(k)!;
      return { key: c.key, name: c.nameEn, element: c.element, inShowcase: showcase.some((s) => s.key === c.key) };
    });
  const resolveTeam = (queries: string[], label: string) => {
    const keys: string[] = [];
    for (const q of queries) {
      if (!q.trim()) continue;
      const k = resolveKey(q);
      if (!k) {
        warnings.push(`${label} "${q}" nggak ketemu — diabaikan`);
        continue;
      }
      if (k === sc.key || keys.includes(k)) continue;
      if (keys.length >= 3) {
        warnings.push(`tim lebih dari 3, "${q}" diabaikan`);
        continue;
      }
      keys.push(k);
    }
    return keys;
  };
  // --team none / solo = paksa tanpa teammate (kalibrasi angka solo)
  const forceSolo = (opts.team ?? []).some((q) => /^(none|solo)$/i.test(q.trim()));
  let teamKeys = forceSolo ? [] : resolveTeam(opts.team ?? [], "teammate");
  let teamSource: TeamSource = teamKeys.length ? "flag" : "none";
  let teamReason = teamKeys.length ? "dari --team" : forceSolo ? "solo (--team none)" : "";
  if (!teamKeys.length && !forceSolo && mode === "offline") {
    const pick = pickTeam(module, guide, resolveKey, sc.key, showcase.map((c) => c.key ?? ""));
    teamKeys = pick.keys;
    teamSource = pick.source;
    teamReason = pick.reason;
  }
  const buildTeamCtx = (keys: string[]): TeamCtx => {
    const members = toMembers(keys);
    const all = [char.element, ...members.map((m) => (m.element ?? "").toLowerCase())];
    return {
      keys,
      elements: teamElements(char.element, members.map((m) => m.element)),
      count: keys.length,
      sameElementCount: all.slice(1).filter((e) => e === char.element).length,
    };
  };
  let teamCtx = buildTeamCtx(teamKeys);
  let ctx = makeCatalogCtx(char, sc, td, showcase, teamCtx);

  const userReactions = parseReactionFlag(opts.reaction);
  let reactions = userReactions;
  let reactionReason = Object.keys(userReactions).length ? "dari --reaction" : "";
  const enemy = defaultEnemy(opts.enemyLevel ?? 90, opts.enemyResPct ?? 10);

  const mkInput = (mods: Modifier[], lunarContributors?: LunarContributor[]): DamageInput => ({
    char,
    hits,
    modifiers: mods,
    reactions,
    enemy,
    swirlElement: char.element === "anemo" ? undefined : char.element,
    stellarHits: opts.stellarHits,
    lunarContributors,
  });

  /**
   * Lunar-Charged aktif kalau ada passive Moonsign (lunarBaseBonus) di modifier — dari enabler di tim atau diri sendiri —
   * dan tim punya Hydro + Electro. Kontributor = semua yang nge-apply Hydro/Electro (stat dari showcase).
   */
  const lunarContributorsFor = (mods: Modifier[], keys: string[]): LunarContributor[] | undefined => {
    if (!mods.some((m) => m.lunarBaseBonus)) return undefined;
    const members = [sc, ...keys.map((k) => showcase.find((c) => c.key === k)).filter((c): c is ShowcaseCharacter => !!c)];
    const elems = new Set(members.map((m) => (m.element ?? "").toLowerCase()));
    if (!elems.has("hydro") || !elems.has("electro")) return undefined;
    const out: LunarContributor[] = [];
    for (const m of members) {
      const el = (m.element ?? "").toLowerCase();
      if (el !== "hydro" && el !== "electro") continue;
      const self = m.key === sc.key;
      const st = self ? resolveStats(char, mods, null) : null;
      out.push({
        key: m.key!,
        name: m.name,
        level: m.level ?? 90,
        em: st ? st.em : m.stats.elementalMastery,
        critRate: st ? st.critRate : m.stats.critRate,
        critDmg: st ? st.critDmg : m.stats.critDmg,
      });
    }
    for (const k of keys) if (!showcase.some((c) => c.key === k)) warnings.push(`Lunar-Charged: ${k} nggak di showcase → nggak dihitung sebagai kontributor`);
    return out.length ? out : undefined;
  };

  // baseline = self "always" + yang dipaksa user, TANPA asumsi & tanpa tim
  const baselineSelf = selfModifiers(ctx, sc, forceIds, false);
  const baseline = computeTalentTable(mkInput(baselineSelf));

  let llm: LlmReportInfo | null = null;
  let rotationSpec: RotationSpec | null = null;
  if (opts.rotation) {
    if (opts.rotation.counts && Object.keys(opts.rotation.counts).length)
      rotationSpec = { label: opts.rotation.label, counts: opts.rotation.counts, source: "flag" };
    else if (opts.rotation.kqm) {
      const p = parseKqmCombo(opts.rotation.kqm, hits, module?.actions ?? {}, module?.limits ?? {});
      if (p.unknown.length) warnings.push(`rotasi: token nggak dikenal: ${p.unknown.join(", ")}`);
      if (Object.keys(p.counts).length)
        rotationSpec = { label: `${opts.rotation.label || "rotasi"} (${opts.rotation.kqm})`, counts: p.counts, source: "flag", kqm: opts.rotation.kqm };
      else warnings.push(`rotasi "${opts.rotation.kqm}" nggak menghasilkan hit apa pun`);
    }
  }
  let catalogUptime: Record<string, number> = {};
  let extraModifiers: AppliedModifier[] = (opts.extraModifiers ?? []).map((m) => ({ ...m, origin: "custom" }));

  const promptCtx: DamagePromptCtx = {
    showcase: sc,
    char,
    talentData: td,
    hits,
    baseline,
    autoModifiers: baselineSelf,
    team: toMembers(teamKeys).map((m) => ({ key: m.key, name: m.name })),
    roster: showcase.filter((c) => c.key && c.key !== sc.key).map((c) => ({ key: c.key!, name: c.name, element: c.element })),
    enemy,
    reactionsFromUser: userReactions,
    catalogCtx: ctx,
  };

  if (mode === "llm") {
    // ---------- jalur LLM ----------
    try {
      const s: LlmDamageSuggestion = await suggestDamageWithLlm(promptCtx, uid, opts.llmOptions ?? {});
      llm = { used: true, model: s.model, cached: s.cached, attempts: s.attempts, usage: s.usage, teamReason: s.teamReason, notes: s.notes, verdict: s.verdict, warnings: s.warnings, error: null };
      if (!teamKeys.length && s.team.length) {
        teamKeys = resolveTeam(s.team, "teammate (LLM)");
        teamSource = teamKeys.length ? "llm" : "none";
        teamReason = s.teamReason;
      }
      for (const id of s.catalogIds) forceIds.add(id);
      catalogUptime = s.catalogUptime;
      if (!Object.keys(userReactions).length) {
        reactions = s.reactions;
        reactionReason = "dari LLM";
      }
      if (!rotationSpec && s.rotation) rotationSpec = { ...s.rotation, source: "llm" };
      if (opts.naInfusion == null && s.naInfusion) char = toDamageCharacter(sc, s.naInfusion, module?.naElements);
      extraModifiers = [...extraModifiers, ...s.customModifiers.map((m) => ({ ...m, origin: "llm" as const }))];
    } catch (err) {
      const msg = err instanceof LlmError ? `${err.code}: ${err.message}` : (err as Error).message;
      llm = { used: false, model: null, cached: false, attempts: 0, teamReason: "", notes: [], verdict: "", warnings: [], error: msg };
      warnings.push(`LLM gagal (${msg}) — lanjut deterministik tanpa asumsi tambahan`);
    }
  } else {
    // ---------- jalur offline (rule + data JSON) ----------
    if (!Object.keys(userReactions).length) {
      const r = inferReactions(module, char, buildTeamCtx(teamKeys).elements);
      reactions = r.reactions;
      reactionReason = r.reason;
    }
    if (!rotationSpec) rotationSpec = pickRotation(module, hits, guide);
    if (!module) warnings.push(`${sc.name} belum punya modul di scrape-data/Buffs — cuma set/senjata/tim generik yang dihitung`);
  }

  teamCtx = buildTeamCtx(teamKeys);
  ctx = makeCatalogCtx(char, sc, td, showcase, teamCtx);
  const allTeamElements = [char.element, ...toMembers(teamKeys).map((m) => (m.element ?? "").toLowerCase())];

  // ---- waktu: durasi rotasi → jendela uptime buff ----
  const timing = rotationSpec ? rotationTimingFor(rotationSpec, hits, module, sc.weaponType, opts.duration) : null;
  if (timing?.unknown.length) warnings.push(`durasi: token nggak ada di _durations.json: ${timing.unknown.join(", ")}`);
  if (rotationSpec && timing && timing.duration == null && rotationSpec.source !== "generic")
    warnings.push(`durasi rotasi nggak diketahui (preset counts tanpa \`duration\` / --duration) — DPS & uptime nyata nggak dihitung`);
  const window = opts.buffWindow ?? timing?.duration ?? undefined;

  const withUptime = (m: AppliedModifier): AppliedModifier => {
    const u = m.id ? catalogUptime[m.id] : undefined;
    return u != null ? { ...m, uptime: u, uptimeSource: "llm", note: `${m.note ? `${m.note}; ` : ""}uptime ${u} (LLM)` } : m;
  };
  const skippedTeam: string[] = [];
  const timingNotes: string[] = [];
  const allMods: AppliedModifier[] = [
    ...selfModifiers(ctx, sc, forceIds, assume, window, timingNotes),
    ...teamModifiers(ctx, teamKeys, allTeamElements, forceIds, assume, opts.teamActions, skippedTeam, window, timingNotes),
    ...extraModifiers,
  ].map(withUptime);
  for (const s of skippedTeam) warnings.push(`buff tim di-skip — ${s}`);
  warnings.push(...timingNotes);

  const lunar = lunarContributorsFor(allMods, teamKeys);
  const buffed = computeTalentTable(mkInput(allMods, lunar));
  warnings.push(...buffed.warnings.filter((w) => !warnings.includes(w)));

  let rotation: DamageReport["rotation"] = null;
  if (rotationSpec?.counts && Object.keys(rotationSpec.counts).length) {
    const r = computeRotation(buffed, rotationSpec.label, rotationSpec.counts, mkInput(allMods, lunar));
    const t: RotationTiming | undefined = timing ? { ...timing, dps: timing.duration ? Math.round(r.total / timing.duration) : null } : undefined;
    rotation = { ...r, timing: t, source: rotationSpec.source, note: rotationSpec.note };
    warnings.push(...r.warnings);
  }
  for (const r of Object.values(reactions))
    if (r && isTransformative(r) && !buffed.transformative.length) warnings.push(`reaksi ${r} transformative — nggak masuk tabel per-hit`);

  return {
    uid,
    fetchedAt: profile.fetchedAt.toISOString(),
    cached: profile.cached,
    mode,
    character: {
      key: sc.key,
      name: sc.name,
      element: char.element,
      weaponType: sc.weaponType,
      level: char.level,
      ascension: sc.ascension,
      constellation: sc.constellation,
      talentLevels: char.talentLevels,
      weapon: sc.weapon,
      sets: sc.sets,
      naElements: char.naElements,
      role: module?.role ?? null,
      hasModule: !!module,
    },
    enemy,
    team: { members: toMembers(teamKeys), source: teamKeys.length ? teamSource : "none", reason: teamReason },
    reactions,
    reactionReason,
    modifiers: allMods,
    baseline,
    buffed,
    rotation,
    llm,
    warnings,
    context: { showcase: sc, talentData: td, hits, prompt: opts.dumpPrompt ? buildDamagePrompt(promptCtx) : undefined },
  };
}
