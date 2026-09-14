import type { Element } from "../lib/stats";

export type { Element };

/** Reaksi yang dimodelkan. Lunar reactions sengaja belum (union dibiarkan terbuka buat nambah). */
export type ReactionKey =
  | "vaporize"
  | "melt"
  | "aggravate"
  | "spread"
  | "overloaded"
  | "burning"
  | "electroCharged"
  | "superconduct"
  | "swirl"
  | "shattered"
  | "bloom"
  | "hyperbloom"
  | "burgeon"
  | "lunarCharged";

export const AMPLIFYING: readonly ReactionKey[] = ["vaporize", "melt"];
export const ADDITIVE: readonly ReactionKey[] = ["aggravate", "spread"];
export const TRANSFORMATIVE: readonly ReactionKey[] = [
  "overloaded",
  "burning",
  "electroCharged",
  "superconduct",
  "swirl",
  "shattered",
  "bloom",
  "hyperbloom",
  "burgeon",
  "lunarCharged", // rumus khusus (kontributor, crit) — lihat computeLunarCharged
];

/** Karakter yang ikut nge-apply Hydro/Electro ke musuh → ikut dihitung di reaksi Lunar-Charged (dirangking 1, ½, 1/12). */
export interface LunarContributor {
  key: string;
  name: string;
  level: number;
  em: number;
  critRate: number;
  critDmg: number;
}

/** Jenis hit; NA/CA/plunge dibedain karena buff & infusion sering scope-nya beda. */
export type HitKind = "na" | "ca" | "plunge" | "skill" | "burst";
export type TalentSlot = "normal" | "skill" | "burst";
export type Scope = "all" | HitKind;
export type ScalingStat = "atk" | "hp" | "def" | "em";

/** Satu bagian multiplier: stat × values[lvl-1] (values pecahan, 0.836 = 83.6%). */
export interface Scaling {
  stat: ScalingStat;
  values: number[];
}

/** Satu baris hit hasil parse label genshin-db. */
export interface HitDef {
  id: string; // na1, ca1, plunge_low, skill1, burst2
  label: string; // "1-Hit DMG"
  kind: HitKind;
  slot: TalentSlot; // buat ambil level talent
  /** bagian yang dijumlah, mis. "5-Hit DMG|{p5}+{p6}" = 2 scaling */
  scalings: Scaling[];
  /** "×2" di label = jumlah hit dengan multiplier yang sama */
  hitCount: number;
  /**
   * Hit Stellar Glimmer ("… Stellar-Conduct DMG" / "… Stellar Swirl DMG"): rumus beda —
   * ATK×MV × koefisien reaksi (Conduct 1.0–2.0) × (1 + EM bonus + stellarBonus) × RES × crit,
   * TANPA DEF musuh dan TANPA DMG% biasa (sumber: guide KQM Stellar Glimmer).
   */
  stellar?: "conduct" | "swirl";
  /**
   * Hit "… Lunar-Charged DMG" (direct Lunar): ATK×MV × 3 × (1 + lunarBaseBonus) × (1 + EM bonus + lunarBonus) × RES × crit,
   * tanpa DEF & tanpa DMG% biasa (guide KQM Lunar + Icy Veins). Bloom/Crystallize belum.
   */
  lunar?: "charged";
}

/**
 * Buff/debuff. Dipakai SAMA oleh katalog hand-coded dan output LLM.
 * Semua persen sebagai angka persen (20 = 20%). `uptime` 0-1 menskala nilai secara linear.
 */
export interface Modifier {
  id?: string;
  source: string;
  scope: Scope | Scope[];
  /** batasi ke hit id tertentu (mis. ["burst1"] cuma initial slash Raiden) */
  hitIds?: string[];
  /** batasi ke hit yang LABEL-nya cocok regex (mis. "Stellar-Conduct" buat buff reaksi Stellar) */
  hitLabelMatch?: string;
  atkPct?: number;
  atkFlat?: number;
  hpPct?: number;
  hpFlat?: number;
  defPct?: number;
  defFlat?: number;
  em?: number;
  /** konversi stat ke ATK flat (Hu Tao E, Noelle/Itto Q): ATK += stat × pct/100, cap % base ATK */
  atkFromStat?: { stat: "hp" | "def" | "em"; pct: number; capPctOfBaseAtk?: number };
  critRate?: number;
  critDmg?: number;
  /** DMG bonus generik (semua elemen) */
  dmgBonus?: number;
  /** DMG bonus khusus elemen tertentu */
  elementalDmgBonus?: Partial<Record<Element, number>>;
  /** bonus reaksi (CW 4pc vape/melt +15) */
  reactionBonus?: Partial<Record<ReactionKey, number>>;
  defShred?: number;
  defIgnore?: number;
  resShred?: Partial<Record<Element, number>>;
  /** multiplier talent × (1 + x/100) (Wanderer Windfavored NA ×1.328 → 32.8) */
  talentMultBonus?: number;
  /** poin persen DITAMBAH ke multiplier (Raiden resolve: +7% × 60 stack = +420) */
  talentMultAdd?: number;
  /** flat DMG ditambah ke base (Yun Jin, Shenhe) */
  flatDmg?: number;
  /**
   * Stellar Glimmer Base DMG bonus (persen) — cuma buat hit Stellar-Conduct/Stellar Swirl
   * (Disenchantment 4pc, Teaspoon, passive Sandrone/Odette). DMG% biasa NGGAK berlaku ke hit Stellar.
   */
  stellarBonus?: number;
  /** Lunar Reaction Base DMG bonus (persen, bracket multiplikatif) — passive Moonsign Ineffa/Columbina */
  lunarBaseBonus?: number;
  /** Lunar Reaction DMG bonus (persen, aditif dengan EM bonus) — Columbina Q, Moonsign tim, Ineffa C1 */
  lunarBonus?: number;
  /** ubah elemen NA/CA/plunge */
  infusion?: Element;
  uptime?: number;
  note?: string;
}

export interface EnemyConfig {
  level: number;
  /** RES per elemen dalam PECAHAN (0.10 = 10%) */
  res: Record<Element, number>;
}

/** Stat sesudah semua modifier di-resolve. Persen sebagai angka persen. */
export interface ResolvedStats {
  atk: number;
  hp: number;
  def: number;
  em: number;
  critRate: number;
  critDmg: number;
  /** DMG bonus per elemen (Enka + modifier generik/elemental), persen */
  dmgBonus: Record<Element, number>;
}

export interface DamageContext {
  charLevel: number;
  /** elemen karakter (buat skill/burst) */
  element: Element;
  /** elemen NA/CA/plunge sesudah infusion */
  naElement: Element;
  talentLevels: Record<TalentSlot, number>;
  stats: ResolvedStats;
  baseStats: { hp: number; atk: number; def: number };
  modifiers: Modifier[];
  reactions: Partial<Record<HitKind, ReactionKey | null>>;
  enemy: EnemyConfig;
}

export interface HitBreakdown {
  base: number;
  additive: number;
  amp: number;
  bonus: number;
  defMult: number;
  resMult: number;
  critRate: number;
  critDmg: number;
  talentLevel: number;
  /** cuma hit Stellar: koefisien reaksi (jumlah hit terekam Polestar Field) + EM bonus */
  stellar?: { coef: number; hits: number; emBonus: number; stellarBonus: number };
}

export interface HitResult {
  id: string;
  label: string;
  kind: HitKind;
  element: Element;
  reaction: ReactionKey | null;
  /** teks multiplier, mis. "242.6% ATK" */
  multiplierText: string;
  nonCrit: number;
  crit: number;
  avg: number;
  hitCount: number;
  /** avg × hitCount */
  total: number;
  breakdown: HitBreakdown;
}

export interface TransformativeResult {
  reaction: ReactionKey;
  element: Element;
  dmg: number;
  breakdown: { levelMult: number; reactionMult: number; emBonus: number; reactionBonus: number; resMult: number };
  /** cuma lunarCharged: rincian per kontributor (sudah dirangking; `weight` 1, ½, 1/12) */
  contributors?: { key: string; name: string; em: number; dmg: number; weight: number }[];
}

export interface DamageTable {
  stats: ResolvedStats;
  hits: HitResult[];
  transformative: TransformativeResult[];
  warnings: string[];
}

export interface RotationRow {
  id: string;
  label: string;
  count: number;
  avg: number;
  subtotal: number;
}

export interface RotationTiming {
  /** detik; null kalau nggak bisa dihitung (preset counts tanpa `duration`) */
  duration: number | null;
  dps: number | null;
  /** "notation" = dari tabel durasi token, "module" = rotations[].duration, "flag" = --duration */
  source: "notation" | "module" | "flag" | null;
  /** rincian per token notasi */
  rows: { token: string; n: number; each: number; subtotal: number }[];
  /** token yang nggak ada di tabel durasi */
  unknown: string[];
}

export interface Rotation {
  label: string;
  counts: Record<string, number>;
  rows: RotationRow[];
  total: number;
  warnings: string[];
  timing?: RotationTiming;
}
