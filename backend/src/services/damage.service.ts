import { ELEMENTS, type Element } from "../lib/stats";
import { multiplierAt } from "../lib/talentLabel";
import { reactionLevelMult } from "../data/reactionLevelMultiplier";
import { DEFAULT_STELLAR_HITS, stellarConductCoef, stellarEmBonus } from "../data/stellar";
import {
  ADDITIVE,
  AMPLIFYING,
  TRANSFORMATIVE,
  type DamageTable,
  type EnemyConfig,
  type HitDef,
  type HitKind,
  type HitResult,
  type LunarContributor,
  type Modifier,
  type ReactionKey,
  type ResolvedStats,
  type Rotation,
  type RotationRow,
  type Scope,
  type TalentSlot,
  type TransformativeResult,
} from "./damage.types";

/**
 * Kalkulator damage murni (nggak ada I/O). Rumus:
 *   base     = Σ mult_i(lvl)·(1+talentMultBonus)·Stat_i + flatDmg
 *   additive = aggravate/spread : levelMult(Lv)·rMult·(1 + 5·EM/(EM+1200) + rBonus)
 *   amp      = vaporize/melt    : rMult·(1 + 2.78·EM/(EM+1400) + rBonus)
 *   nonCrit  = (base + additive) · (1+DMG%) · defMult · resMult · amp
 *   crit     = nonCrit·(1+CD) ; avg = nonCrit·(1 + CR·CD)
 * Transformative: levelMult(Lv)·rMult·(1 + 16·EM/(EM+2000) + rBonus)·resMult
 * Hit Stellar-Conduct (hit.stellar): base·coef(hits)·(1 + 6·EM/(EM+2000) + stellarBonus)·resMult — tanpa DEF & DMG% (data/stellar.ts)
 */

// ---------- input ----------
export interface DamageCharacter {
  key: string | null;
  level: number;
  element: Element;
  /** elemen NA/CA/plunge sesudah infusion bawaan karakter */
  naElements: Record<"na" | "ca" | "plunge", Element>;
  talentLevels: Record<TalentSlot, number>;
  /** stat TOTAL dari Enka (persen sebagai angka persen) */
  final: { hp: number; atk: number; def: number; em: number; critRate: number; critDmg: number };
  base: { hp: number; atk: number; def: number };
  /** DMG bonus per elemen dari Enka, persen */
  dmgBonus: Record<Element, number>;
}

export interface DamageInput {
  char: DamageCharacter;
  hits: HitDef[];
  modifiers: Modifier[];
  reactions: Partial<Record<HitKind, ReactionKey | null>>;
  enemy: EnemyConfig;
  /** elemen yang di-swirl (buat baris transformative swirl) */
  swirlElement?: Element;
  /** hit Cryo/Electro terekam Polestar Field per siklus 4s (koefisien Stellar-Conduct), default 8 */
  stellarHits?: number;
  /**
   * Kontributor reaksi Lunar-Charged (karakter yang nge-apply Hydro/Electro, termasuk diri sendiri).
   * Kosong/undefined = reaksi Lunar nggak dihitung.
   */
  lunarContributors?: LunarContributor[];
}

// ---------- konstanta reaksi ----------
export const REACTION_MULT: Record<ReactionKey, number> = {
  vaporize: 1.5, // pyro trigger; hydro trigger = 2.0 (lihat ampMultiplier)
  melt: 2.0, // pyro trigger; cryo trigger = 1.5
  aggravate: 1.15,
  spread: 1.25,
  overloaded: 2.75,
  burning: 0.25,
  electroCharged: 1.2,
  superconduct: 0.5,
  swirl: 0.6,
  shattered: 1.5,
  bloom: 2,
  hyperbloom: 3,
  burgeon: 3,
  lunarCharged: 1.8, // per kontributor; lihat computeLunarCharged
};

/** reaksi yang bisa dipicu hit dengan elemen tertentu */
const REACTIONS_BY_ELEMENT: Record<Element, ReactionKey[]> = {
  pyro: ["vaporize", "melt", "overloaded", "burning"],
  hydro: ["vaporize", "electroCharged", "bloom"],
  electro: ["aggravate", "overloaded", "electroCharged", "superconduct", "hyperbloom"],
  cryo: ["melt", "superconduct", "shattered"],
  dendro: ["spread", "burning", "bloom", "burgeon"],
  anemo: ["swirl"],
  geo: [],
  physical: ["shattered"],
};

/** elemen damage hasil reaksi transformative */
const TRANSFORMATIVE_ELEMENT: Record<ReactionKey, Element> = {
  overloaded: "pyro",
  burning: "pyro",
  electroCharged: "electro",
  superconduct: "cryo",
  swirl: "anemo", // di-override swirlElement
  shattered: "physical",
  bloom: "dendro",
  hyperbloom: "dendro",
  burgeon: "dendro",
  lunarCharged: "electro",
  vaporize: "pyro",
  melt: "pyro",
  aggravate: "electro",
  spread: "dendro",
};

export function validateReactionForElement(r: ReactionKey, e: Element): boolean {
  return REACTIONS_BY_ELEMENT[e].includes(r);
}

export function isAmplifying(r: ReactionKey): boolean {
  return AMPLIFYING.includes(r);
}
export function isAdditive(r: ReactionKey): boolean {
  return ADDITIVE.includes(r);
}
export function isTransformative(r: ReactionKey): boolean {
  return TRANSFORMATIVE.includes(r);
}

// ---------- helper murni ----------
export function scopeMatches(scope: Scope | Scope[], kind: HitKind | null): boolean {
  const list = Array.isArray(scope) ? scope : [scope];
  if (list.includes("all")) return true;
  return kind != null && list.includes(kind);
}

const labelRe = new Map<string, RegExp>();

/** Modifier kena ke hit ini? (scope + hitIds + hitLabelMatch; kind null = display, cuma scope "all") */
export function modApplies(m: Modifier, kind: HitKind | null, hitId?: string, hitLabel?: string): boolean {
  if (m.hitIds?.length) return hitId != null && m.hitIds.includes(hitId);
  if (m.hitLabelMatch) {
    if (hitLabel == null) return false;
    let re = labelRe.get(m.hitLabelMatch);
    if (!re) {
      re = new RegExp(m.hitLabelMatch, "i");
      labelRe.set(m.hitLabelMatch, re);
    }
    return re.test(hitLabel) && scopeMatches(m.scope, kind);
  }
  return scopeMatches(m.scope, kind);
}

export function defMultiplier(
  lvChar: number,
  lvEnemy: number,
  defShredPct = 0,
  defIgnorePct = 0,
): number {
  const a = lvChar + 100;
  const b = (lvEnemy + 100) * (1 - defShredPct / 100) * (1 - defIgnorePct / 100);
  return a / (a + b);
}

/** res dalam pecahan (0.1 = 10%). */
export function resMultiplier(res: number): number {
  if (res < 0) return 1 - res / 2;
  if (res < 0.75) return 1 - res;
  return 1 / (4 * res + 1);
}

export function ampMultiplier(
  r: ReactionKey,
  triggerElement: Element,
  em: number,
  reactionBonusPct = 0,
): number {
  let mult: number;
  if (r === "vaporize") mult = triggerElement === "hydro" ? 2 : 1.5;
  else if (r === "melt") mult = triggerElement === "cryo" ? 1.5 : 2;
  else return 1;
  return mult * (1 + (2.78 * em) / (em + 1400) + reactionBonusPct / 100);
}

export function additiveBase(
  r: ReactionKey,
  charLevel: number,
  em: number,
  reactionBonusPct = 0,
): number {
  if (!isAdditive(r)) return 0;
  return (
    reactionLevelMult(charLevel) *
    REACTION_MULT[r] *
    (1 + (5 * em) / (em + 1200) + reactionBonusPct / 100)
  );
}

export function transformativeDmg(
  r: ReactionKey,
  charLevel: number,
  em: number,
  reactionBonusPct: number,
  resMult: number,
): TransformativeResult["breakdown"] & { dmg: number } {
  const levelMult = reactionLevelMult(charLevel);
  const reactionMult = REACTION_MULT[r];
  const emBonus = (16 * em) / (em + 2000);
  const dmg = levelMult * reactionMult * (1 + emBonus + reactionBonusPct / 100) * resMult;
  return { dmg, levelMult, reactionMult, emBonus, reactionBonus: reactionBonusPct, resMult };
}

// ---------- resolve stat ----------
function up(m: Modifier): number {
  return m.uptime == null ? 1 : Math.min(Math.max(m.uptime, 0), 1);
}

function sumMod(
  mods: Modifier[],
  kind: HitKind | null,
  pick: (m: Modifier) => number | undefined,
  hitId?: string,
  hitLabel?: string,
): number {
  let s = 0;
  for (const m of mods) {
    if (!modApplies(m, kind, hitId, hitLabel)) continue;
    const v = pick(m);
    if (v) s += v * up(m);
  }
  return s;
}

/** Stat efektif buat hit jenis `kind` (null = cuma modifier scope "all", buat display). */
export function resolveStats(
  char: DamageCharacter,
  mods: Modifier[],
  kind: HitKind | null,
  hitId?: string,
  hitLabel?: string,
): ResolvedStats {
  const S = (pick: (m: Modifier) => number | undefined) => sumMod(mods, kind, pick, hitId, hitLabel);
  const hp = char.final.hp + (char.base.hp * S((m) => m.hpPct)) / 100 + S((m) => m.hpFlat);
  const def = char.final.def + (char.base.def * S((m) => m.defPct)) / 100 + S((m) => m.defFlat);
  const em = char.final.em + S((m) => m.em);
  let atk = char.final.atk + (char.base.atk * S((m) => m.atkPct)) / 100 + S((m) => m.atkFlat);

  // konversi stat → ATK (Hu Tao E, Noelle/Itto Q): pakai HP/DEF/EM yang sudah di-buff
  for (const m of mods) {
    if (!m.atkFromStat || !modApplies(m, kind, hitId, hitLabel)) continue;
    const src = m.atkFromStat.stat === "hp" ? hp : m.atkFromStat.stat === "def" ? def : em;
    let gain = (src * m.atkFromStat.pct) / 100;
    if (m.atkFromStat.capPctOfBaseAtk != null)
      gain = Math.min(gain, (char.base.atk * m.atkFromStat.capPctOfBaseAtk) / 100);
    atk += gain * up(m);
  }

  const dmgBonus = { ...char.dmgBonus };
  const generic = S((m) => m.dmgBonus);
  for (const e of ELEMENTS) {
    dmgBonus[e] += generic + S((m) => m.elementalDmgBonus?.[e]);
  }

  return {
    atk,
    hp,
    def,
    em,
    critRate: char.final.critRate + S((m) => m.critRate),
    critDmg: char.final.critDmg + S((m) => m.critDmg),
    dmgBonus,
  };
}

const STAT_LABEL = { atk: "ATK", hp: "HP", def: "DEF", em: "EM" } as const;

function hitElement(hit: HitDef, char: DamageCharacter, mods: Modifier[]): Element {
  if (hit.kind === "skill" || hit.kind === "burst") return char.element;
  // infusion dari modifier (LLM / katalog) menang atas default karakter
  for (const m of mods) if (m.infusion && modApplies(m, hit.kind, hit.id, hit.label)) return m.infusion;
  return char.naElements[hit.kind];
}

// ---------- per hit ----------
export function computeHit(
  hit: HitDef,
  input: DamageInput,
  warnings: string[],
): HitResult {
  const { char, modifiers: mods, enemy } = input;
  const kind = hit.kind;
  const S = (pick: (m: Modifier) => number | undefined) => sumMod(mods, kind, pick, hit.id, hit.label);
  const stats = resolveStats(char, mods, kind, hit.id, hit.label);
  const level = char.talentLevels[hit.slot];
  const element = hitElement(hit, char, mods);

  const tmb = S((m) => m.talentMultBonus);
  const tma = S((m) => m.talentMultAdd);
  const flat = S((m) => m.flatDmg);

  const parts: string[] = [];
  let base = 0;
  hit.scalings.forEach((s, i) => {
    // talentMultAdd cuma ke bagian pertama biar nggak dobel di hit multi-bagian
    const mult = multiplierAt(s.values, level) * (1 + tmb / 100) + (i === 0 ? tma / 100 : 0);
    const stat = s.stat === "atk" ? stats.atk : s.stat === "hp" ? stats.hp : s.stat === "def" ? stats.def : stats.em;
    base += mult * stat;
    parts.push(`${(mult * 100).toFixed(1)}% ${STAT_LABEL[s.stat]}`);
  });
  base += flat;

  let reaction = input.reactions[kind] ?? null;
  if (reaction && !validateReactionForElement(reaction, element)) {
    warnings.push(`${hit.id}: reaksi ${reaction} nggak cocok sama elemen ${element} — diabaikan`);
    reaction = null;
  }
  if (reaction && isTransformative(reaction)) reaction = null; // transformative bukan multiplier hit

  const rBonus = reaction ? S((m) => m.reactionBonus?.[reaction!]) : 0;
  const additive = reaction ? additiveBase(reaction, char.level, stats.em, rBonus) : 0;
  const amp = reaction ? ampMultiplier(reaction, element, stats.em, rBonus) : 1;

  const res = enemy.res[element] - S((m) => m.resShred?.[element]) / 100;
  const resMult = resMultiplier(res);
  const cr = Math.min(Math.max(stats.critRate, 0), 100);
  const cd = stats.critDmg;

  let bonus: number;
  let defMult: number;
  let nonCrit: number;
  let stellar: HitResult["breakdown"]["stellar"];
  if (hit.stellar) {
    // Stellar Glimmer: tanpa DEF, tanpa DMG% biasa; koefisien reaksi (Conduct) + EM bonus + Stellar base DMG bonus
    const hitsRecorded = input.stellarHits ?? DEFAULT_STELLAR_HITS;
    const coef = hit.stellar === "conduct" ? stellarConductCoef(hitsRecorded) : 1;
    const emBonus = stellarEmBonus(stats.em);
    const stellarBonus = S((m) => m.stellarBonus);
    bonus = 1 + emBonus + stellarBonus / 100;
    defMult = 1;
    nonCrit = base * coef * bonus * resMult;
    stellar = { coef, hits: hitsRecorded, emBonus, stellarBonus };
  } else if (hit.lunar) {
    // direct Lunar-Charged: ×3, bracket base bonus (multiplikatif) × (1 + EM + reaction bonus); tanpa DEF & DMG%
    const emBonus = stellarEmBonus(stats.em);
    const baseB = S((m) => m.lunarBaseBonus);
    const lunarBonus = S((m) => m.lunarBonus);
    bonus = (1 + baseB / 100) * (1 + emBonus + lunarBonus / 100);
    defMult = 1;
    nonCrit = base * LUNAR_DIRECT_MULT * bonus * resMult;
    stellar = { coef: LUNAR_DIRECT_MULT, hits: 0, emBonus, stellarBonus: lunarBonus };
  } else {
    bonus = 1 + stats.dmgBonus[element] / 100;
    defMult = defMultiplier(
      char.level,
      enemy.level,
      S((m) => m.defShred),
      S((m) => m.defIgnore),
    );
    nonCrit = (base + additive) * bonus * defMult * resMult * amp;
  }
  const crit = nonCrit * (1 + cd / 100);
  const avg = nonCrit * (1 + (cr / 100) * (cd / 100));

  return {
    id: hit.id,
    label: hit.label,
    kind,
    element,
    reaction,
    multiplierText: parts.join(" + ") + (hit.hitCount > 1 ? ` ×${hit.hitCount}` : "") + (stellar ? ` ×${stellar.coef.toFixed(2)} ${hit.lunar ? "Lunar" : "Stellar"}` : ""),
    nonCrit,
    crit,
    avg,
    hitCount: hit.hitCount,
    total: avg * hit.hitCount,
    breakdown: { base, additive, amp, bonus, defMult, resMult, critRate: cr, critDmg: cd, talentLevel: level, ...(stellar ? { stellar } : {}) },
  };
}

/** direct Lunar DMG = 300% dari MV asli (Icy Veins/KQM) */
export const LUNAR_DIRECT_MULT = 3;

/**
 * Reaksi Lunar-Charged (1 tick, ~2s sekali): tiap kontributor dihitung sendiri
 *   1.8 × levelMult(lv_i) × (1 + baseBonus) × (1 + 6·EM_i/(EM_i+2000) + lunarBonus) × (1 + CR_i·CD_i) × RES(electro)
 * lalu dirangking: tertinggi + ½ ke-2 + 1/12 ke-3 + 1/12 ke-4. Tanpa DEF, tanpa DMG% biasa.
 * Bonus (base/lunarBonus) party-wide → diambil dari modifier scope "all".
 */
export function computeLunarCharged(input: DamageInput): TransformativeResult {
  const { modifiers: mods, enemy } = input;
  const baseB = sumMod(mods, null, (m) => m.lunarBaseBonus);
  const lunarB = sumMod(mods, null, (m) => m.lunarBonus);
  const res = enemy.res.electro - sumMod(mods, null, (m) => m.resShred?.electro) / 100;
  const resMult = resMultiplier(res);
  const per = (input.lunarContributors ?? []).map((c) => {
    const em = c.em;
    const emBonus = stellarEmBonus(em);
    const cr = Math.min(Math.max(c.critRate, 0), 100) / 100;
    const dmg = REACTION_MULT.lunarCharged * reactionLevelMult(c.level) * (1 + baseB / 100) * (1 + emBonus + lunarB / 100) * (1 + cr * (c.critDmg / 100)) * resMult;
    return { key: c.key, name: c.name, em, dmg, weight: 0 };
  });
  per.sort((a, b) => b.dmg - a.dmg);
  const weights = [1, 0.5, 1 / 12, 1 / 12];
  let total = 0;
  per.forEach((p, i) => {
    p.weight = weights[i] ?? 0;
    total += p.dmg * p.weight;
  });
  const top = per[0];
  return {
    reaction: "lunarCharged",
    element: "electro",
    dmg: total,
    breakdown: {
      levelMult: top ? reactionLevelMult(input.lunarContributors!.find((c) => c.key === top.key)!.level) : 0,
      reactionMult: REACTION_MULT.lunarCharged,
      emBonus: top ? stellarEmBonus(top.em) : 0,
      reactionBonus: lunarB,
      resMult,
    },
    contributors: per,
  };
}

export function computeTransformative(
  r: ReactionKey,
  input: DamageInput,
): TransformativeResult {
  if (r === "lunarCharged") return computeLunarCharged(input);
  const { char, modifiers: mods, enemy } = input;
  const stats = resolveStats(char, mods, null);
  const element = r === "swirl" && input.swirlElement ? input.swirlElement : TRANSFORMATIVE_ELEMENT[r];
  const rBonus = sumMod(mods, null, (m) => m.reactionBonus?.[r]);
  const res = enemy.res[element] - sumMod(mods, null, (m) => m.resShred?.[element]) / 100;
  const { dmg, ...breakdown } = transformativeDmg(r, char.level, stats.em, rBonus, resMultiplier(res));
  return { reaction: r, element, dmg, breakdown };
}

// ---------- tabel ----------
export function computeTalentTable(input: DamageInput): DamageTable {
  const warnings: string[] = [];
  const hits = input.hits.map((h) => computeHit(h, input, warnings));

  // baris transformative: yang dipilih di reactions (kind apa pun) + yang bisa dipicu elemen karakter
  const chosen = new Set<ReactionKey>();
  for (const r of Object.values(input.reactions)) if (r && isTransformative(r)) chosen.add(r);
  if (input.lunarContributors?.length) chosen.add("lunarCharged");
  const transformative = [...chosen].map((r) => computeTransformative(r, input));

  return { stats: resolveStats(input.char, input.modifiers, null), hits, transformative, warnings };
}

/** counts: hitId -> jumlah, atau "react:<reaksi>" -> jumlah proc transformative. */
export function computeRotation(
  table: DamageTable,
  label: string,
  counts: Record<string, number>,
  input?: DamageInput,
): Rotation {
  const rows: RotationRow[] = [];
  const warnings: string[] = [];
  let total = 0;
  for (const [id, count] of Object.entries(counts)) {
    if (!count || count < 0) continue;
    if (id.startsWith("react:")) {
      const r = id.slice(6) as ReactionKey;
      if (!isTransformative(r) || !input) {
        warnings.push(`rotasi: reaksi "${r}" nggak dikenal`);
        continue;
      }
      const t = table.transformative.find((x) => x.reaction === r) ?? computeTransformative(r, input);
      if (r === "lunarCharged" && !t.dmg) continue; // Lunar nggak aktif di tim ini → baris nggak relevan
      const subtotal = t.dmg * count;
      rows.push({ id, label: `${r} (transformative)`, count, avg: t.dmg, subtotal });
      total += subtotal;
      continue;
    }
    const hit = table.hits.find((h) => h.id === id);
    if (!hit) {
      warnings.push(`rotasi: hit "${id}" nggak ada di tabel`);
      continue;
    }
    const subtotal = hit.total * count;
    rows.push({ id, label: hit.label, count, avg: hit.total, subtotal });
    total += subtotal;
  }
  return { label, counts, rows, total, warnings };
}

export function defaultEnemy(level = 90, resPct = 10): EnemyConfig {
  return {
    level,
    res: Object.fromEntries(ELEMENTS.map((e) => [e, resPct / 100])) as Record<Element, number>,
  };
}
