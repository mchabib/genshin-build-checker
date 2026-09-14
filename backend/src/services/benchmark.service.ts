import { benchmarkConfig, loadBuffStore, type BenchmarkConfig } from "./buffStore";
import { getGuide, loadGuideStore } from "./guideStore";
import { loadCharacterStore } from "./characterStore";
import { loadGameDataStore } from "./gameDataStore";
import { fetchEnkaProfile, isValidUid } from "./enka.service";
import { EnkaError } from "./enka.types";
import { mapShowcase, type ShowcaseArtifact, type ShowcaseCharacter } from "./enka.mapper";
import { CheckError } from "./check.service";
import { chooseErAuto, type ErRequirement, type GuideBuild } from "./scoring.service";
import { findInShowcase, runDamage, type DamageOptions, type DamageReport } from "./damage.run";
import { ELEMENTS, STAT_KEY_TO_KQM, type Element, type NormalizedStats, type StatKey } from "../lib/stats";

/**
 * Benchmark ala Akasha tapi offline: build acuan = build user (level, C, talent, senjata, set) dengan
 * ARTIFACT diganti standar KQMS (main stat dari guide KQM + substat 20 roll tetap + 20 roll bebas,
 * `scrape-data/Buffs/_benchmark.json`). Tim, rotasi, reaksi, musuh SAMA → skor = total user / total acuan.
 *
 * Stat non-artifact (ascension, senjata, 2pc set, passive statis) nggak butuh tabel: diturunkan dari Enka
 * `other = total Enka − kontribusi artifact user`, lalu `acuan = other + kontribusi artifact standar`.
 */

/** token KQM → StatKey (kebalikan STAT_KEY_TO_KQM) */
const KQM_TO_KEY: Record<string, StatKey> = Object.fromEntries(
  Object.entries(STAT_KEY_TO_KQM).map(([k, v]) => [v, k as StatKey]),
) as Record<string, StatKey>;

const SUBSTAT_TOKENS = ["CRIT Rate", "CRIT DMG", "ATK%", "HP%", "DEF%", "EM", "ER", "Flat ATK", "Flat HP", "Flat DEF"] as const;
type SubstatToken = (typeof SUBSTAT_TOKENS)[number];

/** Kontribusi artifact ke stat, dalam satuan yang sama dengan NormalizedStats (persen = angka persen). */
export interface ArtifactContribution {
  stat: Partial<Record<StatKey, number>>;
  /** goblet DMG per elemen */
  dmg: Partial<Record<Element, number>>;
}

export function artifactContribution(artifacts: ShowcaseArtifact[]): ArtifactContribution {
  const stat: Partial<Record<StatKey, number>> = {};
  const dmg: Partial<Record<Element, number>> = {};
  const add = (token: string, v: number, element?: Element) => {
    if (token === "Elemental DMG" || token === "Physical DMG") {
      const el = element ?? (token === "Physical DMG" ? "physical" : undefined);
      if (el) dmg[el] = (dmg[el] ?? 0) + v;
      return;
    }
    const key = KQM_TO_KEY[token];
    if (key) stat[key] = (stat[key] ?? 0) + v;
  };
  for (const a of artifacts) {
    add(a.mainStat.stat, a.mainStat.value, a.mainStat.element);
    for (const s of a.substats) add(s.stat, s.value);
  }
  return { stat, dmg };
}

export interface ReferenceArtifact {
  slot: string;
  mainStat: string;
  /** substat token → jumlah roll (tetap + bebas) — dibagi rata cuma buat tampilan */
  rolls: Partial<Record<SubstatToken, number>>;
}

export interface ReferenceBuild {
  buildName: string | null;
  mains: Record<"flower" | "plume" | "sands" | "goblet" | "circlet", string>;
  /** roll per substat: tetap + bebas, dan nilai totalnya */
  substats: Record<SubstatToken, { fixed: number; liquid: number; value: number }>;
  erTarget: number | null;
  erSource: string | null;
  /** kontribusi main + substat acuan; `dmg.self` = goblet "Elemental DMG" (elemen karakter) */
  contribution: { stat: Partial<Record<StatKey, number>>; dmg: { self: number; physical: number } };
  artifacts: ReferenceArtifact[];
  notes: string[];
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Pilih main stat dari daftar rekomendasi guide; "CRIT" → pakai `critPick`. */
function pickMain(allowed: string[], fallback: string, critPick: "CRIT Rate" | "CRIT DMG", cfg: BenchmarkConfig): string {
  for (const a of allowed) {
    if (norm(a) === "crit") return critPick;
    const tok = Object.keys(cfg.mainStatValue).find((k) => norm(k) === norm(a));
    if (tok) return tok;
  }
  return fallback;
}

/**
 * Susun artifact standar. `base` = stat non-artifact (buat jaga rasio CR:CD & target ER), persen.
 */
export function buildReference(
  build: GuideBuild | null,
  cfg: BenchmarkConfig,
  base: { critRate: number; critDmg: number; er: number },
  erTarget: number | null,
  erSource: string | null,
  critPick: "CRIT Rate" | "CRIT DMG" = "CRIT Rate",
): ReferenceBuild {
  const notes: string[] = [];
  const mains = {
    flower: "Flat HP",
    plume: "Flat ATK",
    sands: pickMain(build?.sands ?? [], "ATK%", critPick, cfg),
    goblet: pickMain(build?.goblet ?? [], "Elemental DMG", critPick, cfg),
    circlet: pickMain(build?.circlet ?? [], critPick, critPick, cfg),
  };
  if (!build) notes.push("guide KQM nggak punya build terparse → main stat default ATK% / Elemental DMG / CRIT");

  const rv = (t: SubstatToken) => cfg.rollValue[t] ?? 0;
  const fixed = cfg.fixedRollsPerSubstat;
  const liquid: Record<SubstatToken, number> = Object.fromEntries(SUBSTAT_TOKENS.map((t) => [t, 0])) as Record<SubstatToken, number>;
  // cap roll bebas: 2 per artifact yang main stat-nya BUKAN stat itu
  const cap = (t: SubstatToken) =>
    cfg.maxLiquidPerSubstatPerArtifact * Object.values(mains).filter((m) => m !== t).length;
  let remaining = cfg.liquidRolls;
  const give = (t: SubstatToken, n: number) => {
    const k = Math.max(0, Math.min(n, cap(t) - liquid[t], remaining));
    liquid[t] += k;
    remaining -= k;
    return k;
  };
  const mainVal = (t: string) => Object.values(mains).filter((m) => m === t).length * (cfg.mainStatValue[t] ?? 0);
  const total = (t: SubstatToken) => (fixed + liquid[t]) * rv(t) + mainVal(t);

  // 1. ER sampai target
  if (erTarget != null) {
    const erNow = () => base.er + total("ER");
    const need = erTarget - erNow();
    if (need > 0) {
      const got = give("ER", Math.ceil(need / rv("ER")));
      if (erNow() < erTarget - 1) notes.push(`ER acuan ${erNow().toFixed(1)}% belum nyampe target ${erTarget}% (cap roll ER ${cap("ER")}, dapat ${got})`);
    }
  }

  // 2. prioritas substat guide; "CRIT" = CR/CD bergantian jaga rasio
  const crNow = () => base.critRate + total("CRIT Rate");
  const cdNow = () => base.critDmg + total("CRIT DMG");
  const giveCrit = () => {
    while (remaining > 0) {
      const wantCd = cdNow() < cfg.critRatio * crNow();
      const first: SubstatToken = wantCd ? "CRIT DMG" : "CRIT Rate";
      const second: SubstatToken = wantCd ? "CRIT Rate" : "CRIT DMG";
      if (!give(first, 1) && !give(second, 1)) break;
    }
  };
  let priority = (build?.substatPriority ?? []).map((p) => p.trim());
  // "CRIT Rate > CRIT DMG" (dua-duanya ada) = sama dengan "CRIT" — jaga rasio, bukan CR dulu sampai cap
  if (priority.some((p) => norm(p) === "critrate") && priority.some((p) => norm(p) === "critdmg")) {
    let seen = false;
    priority = priority.flatMap((p) => {
      if (norm(p) !== "critrate" && norm(p) !== "critdmg") return [p];
      if (seen) return [];
      seen = true;
      return ["CRIT"];
    });
  }
  for (const p of priority) {
    if (remaining <= 0) break;
    const n = norm(p);
    if (n === "crit") giveCrit();
    else if (n === "er") continue; // ER = "sampai requirement", sudah di langkah 1
    else {
      const tok = SUBSTAT_TOKENS.find((t) => norm(t) === n);
      if (tok) give(tok, remaining);
    }
  }
  // sisa (prioritas habis): CRIT dulu, lalu stat prioritas lagi, lalu apa pun kecuali flat/DEF%
  if (remaining > 0) giveCrit();
  for (const t of ["ATK%", "HP%", "EM", "ER"] as SubstatToken[]) if (remaining > 0 && priority.some((p) => norm(p) === norm(t))) give(t, remaining);
  for (const t of ["ATK%", "EM", "HP%", "Flat ATK", "Flat HP", "DEF%", "Flat DEF"] as SubstatToken[]) if (remaining > 0) give(t, remaining);

  const substats = Object.fromEntries(
    SUBSTAT_TOKENS.map((t) => [t, { fixed, liquid: liquid[t], value: Math.round((fixed + liquid[t]) * rv(t) * 10) / 10 }]),
  ) as ReferenceBuild["substats"];

  // kontribusi total (main + substat) dalam StatKey
  const contribution: ReferenceBuild["contribution"] = { stat: {}, dmg: { self: 0, physical: 0 } };
  const addStat = (tok: string, v: number) => {
    const key = KQM_TO_KEY[tok];
    if (key) contribution.stat[key] = (contribution.stat[key] ?? 0) + v;
  };
  for (const m of Object.values(mains)) {
    if (m === "Elemental DMG") contribution.dmg.self += cfg.mainStatValue[m] ?? 0;
    else if (m === "Physical DMG") contribution.dmg.physical += cfg.mainStatValue[m] ?? 0;
    else addStat(m, cfg.mainStatValue[m] ?? 0);
  }
  for (const t of SUBSTAT_TOKENS) addStat(t, substats[t].value);

  // tampilan: roll dibagi rata ke 5 artifact (nggak dipakai buat hitung)
  const artifacts: ReferenceArtifact[] = (["flower", "plume", "sands", "goblet", "circlet"] as const).map((slot) => ({
    slot,
    mainStat: mains[slot],
    rolls: {},
  }));
  for (const t of SUBSTAT_TOKENS) {
    let n = fixed + liquid[t];
    for (let i = 0; n > 0; i = (i + 1) % 5) {
      if (artifacts[i].mainStat === t) continue;
      artifacts[i].rolls[t] = (artifacts[i].rolls[t] ?? 0) + 1;
      n--;
    }
  }

  return { buildName: build?.name ?? null, mains, substats, erTarget, erSource, contribution, artifacts, notes };
}

/** Karakter showcase dengan artifact diganti acuan: total = (total Enka − artifact user) + artifact acuan. */
export function referenceShowcase(sc: ShowcaseCharacter, ref: ReferenceBuild): ShowcaseCharacter {
  const user = artifactContribution(sc.artifacts);
  const selfEl = (sc.element ?? "physical").toLowerCase() as Element;
  const r1 = (n: number) => Math.round(n * 10) / 10;
  const u = (k: StatKey) => user.stat[k] ?? 0;
  const r = (k: StatKey) => ref.contribution.stat[k] ?? 0;
  const s = sc.stats;

  // HP/ATK/DEF: final = base × (1 + %total) + flat; residual flat = sumber non-artifact (biasanya ≈ 0)
  const recompute = (final: number, base: number, pctTotal: number, pctKey: StatKey, flatKey: StatKey) => {
    const flatOther = final - base * (1 + pctTotal / 100) - u(flatKey);
    const pct = pctTotal - u(pctKey) + r(pctKey);
    return { value: Math.round(base * (1 + pct / 100) + flatOther + r(flatKey)), pct: r1(pct) };
  };
  const hp = recompute(sc.finalStats.hp, sc.baseStats.hp, s.hpPercent ?? 0, "hpPercent", "hpFlat");
  const atk = recompute(sc.finalStats.atk, sc.baseStats.atk, s.atkPercent ?? 0, "atkPercent", "atkFlat");
  const def = recompute(sc.finalStats.def, sc.baseStats.def, s.defPercent ?? 0, "defPercent", "defFlat");

  const swap = (v: number, k: StatKey) => r1(v - u(k) + r(k));
  const dmgBonus = { ...sc.dmgBonus };
  for (const el of ELEMENTS) dmgBonus[el] = r1(dmgBonus[el] - (user.dmg[el] ?? 0));
  dmgBonus[selfEl] = r1(dmgBonus[selfEl] + ref.contribution.dmg.self);
  dmgBonus.physical = r1(dmgBonus.physical + ref.contribution.dmg.physical);

  const stats: NormalizedStats = {
    ...s,
    critRate: swap(s.critRate, "critRate"),
    critDmg: swap(s.critDmg, "critDmg"),
    energyRecharge: swap(s.energyRecharge, "energyRecharge"),
    elementalMastery: swap(s.elementalMastery, "elementalMastery"),
    hpPercent: hp.pct,
    atkPercent: atk.pct,
    defPercent: def.pct,
    healingBonus: s.healingBonus != null ? swap(s.healingBonus, "healingBonus") : undefined,
    physicalDmgBonus: dmgBonus.physical,
    elementalDmgBonus: Math.max(...ELEMENTS.filter((e) => e !== "physical").map((e) => dmgBonus[e])),
  };

  const substatTotals: Partial<Record<StatKey, number>> = {};
  for (const t of SUBSTAT_TOKENS) substatTotals[KQM_TO_KEY[t]] = ref.substats[t].value;
  const mainValue = benchmarkConfig()?.mainStatValue ?? {};
  const perRoll = (t: SubstatToken) => {
    const s = ref.substats[t];
    return s.value / Math.max(1, s.fixed + s.liquid);
  };
  const artifacts: ShowcaseArtifact[] = ref.artifacts.map((a) => ({
    slot: a.slot,
    setName: sc.artifacts.find((x) => x.slot === a.slot)?.setName ?? sc.artifacts[0]?.setName ?? null,
    level: 20,
    rarity: 5,
    mainStat: {
      stat: a.mainStat,
      value: mainValue[a.mainStat] ?? 0,
      element: a.mainStat === "Elemental DMG" ? selfEl : a.mainStat === "Physical DMG" ? "physical" : undefined,
    },
    substats: Object.entries(a.rolls).map(([stat, n]) => ({ stat, value: r1((n as number) * perRoll(stat as SubstatToken)) })),
  }));

  return {
    ...sc,
    stats,
    finalStats: { hp: hp.value, atk: atk.value, def: def.value },
    dmgBonus,
    artifacts,
    substatTotals,
    substatCritValue: r1(ref.substats["CRIT Rate"].value * 2 + ref.substats["CRIT DMG"].value),
  };
}

export interface BenchmarkOptions extends Pick<DamageOptions, "team" | "reaction" | "enemyLevel" | "enemyResPct" | "catalogIds" | "rotation" | "duration" | "noAssume" | "stellarHits"> {
  buildIndex?: number;
  erLabel?: string;
  /** paksa target ER acuan (persen); default dari ER requirement guide (auto/label) */
  erTarget?: number;
}

export interface StatDelta {
  stat: string;
  user: number;
  reference: number;
  delta: number;
}

export interface BenchmarkReport {
  uid: string;
  character: DamageReport["character"];
  build: { index: number; name: string | null; source: "kqm" | "default" };
  reference: ReferenceBuild & { stats: { hp: number; atk: number; def: number; em: number; critRate: number; critDmg: number; er: number; dmgBonus: number }; total: number; dps: number | null };
  user: { stats: BenchmarkReport["reference"]["stats"]; total: number; dps: number | null };
  /** total user / total acuan */
  ratio: number;
  status: "pass" | "warn" | "fail";
  deltas: StatDelta[];
  verdict: string;
  rotation: { label: string; source: string; duration: number | null };
  team: DamageReport["team"];
  reactions: DamageReport["reactions"];
  warnings: string[];
  reports: { user: Omit<DamageReport, "context">; reference: Omit<DamageReport, "context"> };
}

function statsOf(r: DamageReport): BenchmarkReport["reference"]["stats"] {
  const sc = r.context.showcase;
  return {
    hp: sc.finalStats.hp,
    atk: sc.finalStats.atk,
    def: sc.finalStats.def,
    em: sc.stats.elementalMastery,
    critRate: sc.stats.critRate,
    critDmg: sc.stats.critDmg,
    er: sc.stats.energyRecharge,
    dmgBonus: sc.dmgBonus[r.character.element] ?? 0,
  };
}

/** Pilih target ER dari guide: label eksplisit → auto (senjata/con) → min dari semua arketipe. */
export function pickErTarget(reqs: ErRequirement[], sc: ShowcaseCharacter, erLabel?: string): { target: number | null; source: string | null } {
  if (!reqs.length) return { target: null, source: null };
  if (erLabel) {
    const r = reqs.find((x) => norm(x.label).includes(norm(erLabel)));
    if (r) return { target: r.min, source: `label "${r.label}"` };
  }
  const auto = chooseErAuto(reqs, sc.weapon, sc.constellation);
  if (auto) return { target: auto.req.min, source: `${auto.req.label} (${auto.why})` };
  const lo = reqs.reduce((a, b) => (b.min < a.min ? b : a));
  return { target: lo.min, source: `${lo.label} (arketipe ER terendah)` };
}

export async function runBenchmark(rawUid: string, characterQuery: string, opts: BenchmarkOptions = {}): Promise<BenchmarkReport> {
  const uid = rawUid.trim();
  if (!isValidUid(uid)) throw new EnkaError("INVALID_UID", `UID tidak valid: "${uid}"`, 400);
  await Promise.all([loadCharacterStore(), loadGuideStore(), loadGameDataStore(), loadBuffStore()]);
  const cfg = benchmarkConfig();
  if (!cfg) throw new CheckError("no_guide", "scrape-data/Buffs/_benchmark.json nggak ada — benchmark butuh config standar.");

  const profile = await fetchEnkaProfile(uid);
  const showcase = mapShowcase(profile.data);
  const sc = findInShowcase(showcase, characterQuery);
  if (!sc?.key) throw new CheckError("not_in_showcase", `"${characterQuery}" nggak ada di showcase UID ${uid}.`);

  const guide = getGuide(sc.key);
  const builds = guide?.parsed.builds ?? [];
  const buildIndex = Math.min(opts.buildIndex ?? 0, Math.max(0, builds.length - 1));
  const build = builds[buildIndex] ?? null;
  const er = opts.erTarget != null ? { target: opts.erTarget, source: "--er-target" } : pickErTarget(guide?.parsed.erRequirements ?? [], sc, opts.erLabel);

  // stat non-artifact buat rasio crit & ER acuan
  const userContrib = artifactContribution(sc.artifacts);
  const base = {
    critRate: sc.stats.critRate - (userContrib.stat.critRate ?? 0),
    critDmg: sc.stats.critDmg - (userContrib.stat.critDmg ?? 0),
    er: sc.stats.energyRecharge - (userContrib.stat.energyRecharge ?? 0),
  };
  // circlet "CRIT": coba CR dan CD, ambil yang rasio CR:CD-nya paling dekat critRatio
  const wantsCritCirclet = (build?.circlet ?? []).some((c) => norm(c) === "crit");
  let ref = buildReference(build, cfg, base, er.target, er.source, "CRIT Rate");
  if (wantsCritCirclet) {
    const alt = buildReference(build, cfg, base, er.target, er.source, "CRIT DMG");
    const ratio = (x: ReferenceBuild) => {
      const cr = base.critRate + (x.contribution.stat.critRate ?? 0);
      const cd = base.critDmg + (x.contribution.stat.critDmg ?? 0);
      return Math.abs(cd / Math.max(cr, 1) - cfg.critRatio);
    };
    if (ratio(alt) < ratio(ref)) ref = alt;
  }
  const refSc = referenceShowcase(sc, ref);

  const common: DamageOptions = {
    team: opts.team,
    reaction: opts.reaction,
    enemyLevel: opts.enemyLevel,
    enemyResPct: opts.enemyResPct,
    catalogIds: opts.catalogIds,
    rotation: opts.rotation,
    duration: opts.duration,
    noAssume: opts.noAssume,
    stellarHits: opts.stellarHits,
    llm: false,
  };
  const userReport = await runDamage(uid, sc.key, common);
  // acuan pakai keputusan yang SAMA persis dengan user (tim, rotasi, reaksi)
  const same: DamageOptions = {
    ...common,
    team: userReport.team.members.map((m) => m.key),
    rotation: userReport.rotation ? { label: userReport.rotation.label, counts: userReport.rotation.counts } : common.rotation,
    duration: userReport.rotation?.timing?.duration ?? common.duration,
    reaction: Object.entries(userReport.reactions).map(([k, v]) => `${k}=${v ?? "none"}`).join(",") || undefined,
    showcaseOverride: refSc,
  };
  const refReport = await runDamage(uid, sc.key, same);

  const userTotal = userReport.rotation?.total ?? userReport.buffed.hits.reduce((a, h) => a + h.total, 0);
  const refTotal = refReport.rotation?.total ?? refReport.buffed.hits.reduce((a, h) => a + h.total, 0);
  const ratio = refTotal > 0 ? Math.round((userTotal / refTotal) * 1000) / 1000 : 0;
  const status: BenchmarkReport["status"] = ratio >= cfg.grade.pass ? "pass" : ratio >= cfg.grade.warn ? "warn" : "fail";

  const us = statsOf(userReport);
  const rs = statsOf(refReport);
  const deltas: StatDelta[] = (
    [
      ["HP", us.hp, rs.hp],
      ["ATK", us.atk, rs.atk],
      ["DEF", us.def, rs.def],
      ["EM", us.em, rs.em],
      ["CRIT Rate", us.critRate, rs.critRate],
      ["CRIT DMG", us.critDmg, rs.critDmg],
      ["ER", us.er, rs.er],
      [`${userReport.character.element} DMG%`, us.dmgBonus, rs.dmgBonus],
    ] as [string, number, number][]
  ).map(([stat, user, reference]) => ({ stat, user, reference, delta: Math.round((user - reference) * 10) / 10 }));

  const pct = Math.round(ratio * 100);
  const worst = deltas
    .filter((d) => d.reference > 0 && d.delta < 0)
    .map((d) => ({ ...d, rel: d.delta / d.reference }))
    .sort((a, b) => a.rel - b.rel)
    .slice(0, 2);
  const verdict =
    status === "pass"
      ? `Build ${pct}% dari standar KQMS — setara/lebih baik dari build acuan.`
      : `Build ${pct}% dari standar KQMS.${worst.length ? ` Paling ketinggalan: ${worst.map((w) => `${w.stat} ${w.user} vs ${w.reference}`).join(", ")}.` : ""}`;

  const warnings = [...ref.notes];
  if (!guide) warnings.push("belum ada guide KQM → main stat acuan default");
  if (er.target == null) warnings.push("ER requirement guide nggak keparse → acuan nggak nambah roll ER (pakai --er-target kalau mau)");
  const drop = (r: DamageReport): Omit<DamageReport, "context"> => {
    const { context: _c, ...rest } = r;
    return rest;
  };
  return {
    uid,
    character: userReport.character,
    build: { index: buildIndex, name: build?.name ?? null, source: build ? "kqm" : "default" },
    reference: { ...ref, stats: rs, total: Math.round(refTotal), dps: refReport.rotation?.timing?.dps ?? null },
    user: { stats: us, total: Math.round(userTotal), dps: userReport.rotation?.timing?.dps ?? null },
    ratio,
    status,
    deltas,
    verdict,
    rotation: { label: userReport.rotation?.label ?? "semua hit 1×", source: userReport.rotation?.source ?? "none", duration: userReport.rotation?.timing?.duration ?? null },
    team: userReport.team,
    reactions: userReport.reactions,
    warnings,
    reports: { user: drop(userReport), reference: drop(refReport) },
  };
}

/** Ringkasan buat `check` (scoring) — dipakai check.service lewat dynamic import biar nggak circular. */
export interface BenchmarkSummary {
  ratio: number;
  status: BenchmarkReport["status"];
  verdict: string;
  buildName: string | null;
  userTotal: number;
  referenceTotal: number;
  rotation: string;
  deltas: StatDelta[];
}

export function summarize(r: BenchmarkReport): BenchmarkSummary {
  return {
    ratio: r.ratio,
    status: r.status,
    verdict: r.verdict,
    buildName: r.build.name,
    userTotal: r.user.total,
    referenceTotal: r.reference.total,
    rotation: r.rotation.label,
    deltas: r.deltas,
  };
}
