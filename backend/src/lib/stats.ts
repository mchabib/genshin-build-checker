/** Kunci stat internal yang dipakai di seluruh app. */
export type StatKey =
  | "critRate"
  | "critDmg"
  | "energyRecharge"
  | "elementalMastery"
  | "atkPercent"
  | "atkFlat"
  | "hpPercent"
  | "hpFlat"
  | "defPercent"
  | "defFlat"
  | "elementalDmgBonus"
  | "physicalDmgBonus"
  | "healingBonus";

export const STAT_LABELS: Record<StatKey, string> = {
  critRate: "CRIT Rate",
  critDmg: "CRIT DMG",
  energyRecharge: "Energy Recharge",
  elementalMastery: "Elemental Mastery",
  atkPercent: "ATK%",
  atkFlat: "ATK",
  hpPercent: "HP%",
  hpFlat: "HP",
  defPercent: "DEF%",
  defFlat: "DEF",
  elementalDmgBonus: "Elemental DMG Bonus",
  physicalDmgBonus: "Physical DMG Bonus",
  healingBonus: "Healing Bonus",
};

/** StatKey internal -> token kanonik ala KQM (dipakai buat cocokin ke guide). */
export const STAT_KEY_TO_KQM: Record<StatKey, string> = {
  critRate: "CRIT Rate",
  critDmg: "CRIT DMG",
  energyRecharge: "ER",
  elementalMastery: "EM",
  atkPercent: "ATK%",
  atkFlat: "Flat ATK",
  hpPercent: "HP%",
  hpFlat: "Flat HP",
  defPercent: "DEF%",
  defFlat: "Flat DEF",
  elementalDmgBonus: "Elemental DMG",
  physicalDmgBonus: "Physical DMG",
  healingBonus: "Healing Bonus",
};

/** Stat yang nilainya persen (disimpan sebagai angka persen, mis. 70.2 = 70.2%). */
export const PERCENT_STATS: ReadonlySet<StatKey> = new Set<StatKey>([
  "critRate",
  "critDmg",
  "energyRecharge",
  "atkPercent",
  "hpPercent",
  "defPercent",
  "elementalDmgBonus",
  "physicalDmgBonus",
  "healingBonus",
]);

/**
 * Total stat karakter (sudah termasuk base). Semua persen sebagai angka persen:
 * ER 160 artinya 160%. EM sebagai angka flat.
 */
export interface NormalizedStats {
  critRate: number;
  critDmg: number;
  energyRecharge: number;
  elementalMastery: number;
  atkPercent?: number;
  hpPercent?: number;
  defPercent?: number;
  /** DMG bonus elemen TERTINGGI (Fase 1 cuma butuh 1 angka; per-elemen ada di ShowcaseCharacter.dmgBonus) */
  elementalDmgBonus?: number;
  physicalDmgBonus?: number;
  healingBonus?: number;
}

/** Elemen damage (physical ikut, karena NA non-catalyst default physical). */
export type Element =
  | "pyro"
  | "hydro"
  | "electro"
  | "cryo"
  | "dendro"
  | "anemo"
  | "geo"
  | "physical";

export const ELEMENTS: readonly Element[] = [
  "pyro",
  "hydro",
  "electro",
  "cryo",
  "dendro",
  "anemo",
  "geo",
  "physical",
];

/** id fightPropMap DMG bonus -> elemen (nilai pecahan). */
export const ENKA_ELEMENT_DMG_PROP: Record<string, Element> = {
  "30": "physical",
  "40": "pyro",
  "41": "electro",
  "42": "hydro",
  "43": "dendro",
  "44": "anemo",
  "45": "geo",
  "46": "cryo",
};

/** id fightPropMap RES -> elemen (nilai pecahan; jarang diisi Enka buat karakter). */
export const ENKA_ELEMENT_RES_PROP: Record<string, Element> = {
  "29": "physical",
  "50": "pyro",
  "51": "electro",
  "52": "hydro",
  "53": "dendro",
  "54": "anemo",
  "55": "geo",
  "56": "cryo",
};

/** appendPropId (substat artifact Enka) -> StatKey */
export const ENKA_APPEND_PROP_TO_KEY: Record<string, StatKey> = {
  FIGHT_PROP_CRITICAL: "critRate",
  FIGHT_PROP_CRITICAL_HURT: "critDmg",
  FIGHT_PROP_CHARGE_EFFICIENCY: "energyRecharge",
  FIGHT_PROP_ELEMENT_MASTERY: "elementalMastery",
  FIGHT_PROP_ATTACK_PERCENT: "atkPercent",
  FIGHT_PROP_ATTACK: "atkFlat",
  FIGHT_PROP_HP_PERCENT: "hpPercent",
  FIGHT_PROP_HP: "hpFlat",
  FIGHT_PROP_DEFENSE_PERCENT: "defPercent",
  FIGHT_PROP_DEFENSE: "defFlat",
  FIGHT_PROP_HEAL_ADD: "healingBonus",
};

/**
 * id fightPropMap (total stat karakter dari Enka) -> StatKey.
 * Nilai crit/ER/dmg-bonus di Enka berupa pecahan (0.702), EM flat.
 */
export const ENKA_FIGHT_PROP_TO_KEY: Record<string, StatKey> = {
  "3": "hpPercent",
  "6": "atkPercent",
  "9": "defPercent",
  "20": "critRate",
  "22": "critDmg",
  "23": "energyRecharge",
  "26": "healingBonus",
  "28": "elementalMastery",
  "30": "physicalDmgBonus",
  "40": "elementalDmgBonus", // Pyro
  "41": "elementalDmgBonus", // Electro
  "42": "elementalDmgBonus", // Hydro
  "43": "elementalDmgBonus", // Dendro
  "44": "elementalDmgBonus", // Anemo
  "45": "elementalDmgBonus", // Geo
  "46": "elementalDmgBonus", // Cryo
};

/** id fightPropMap yang nilainya pecahan dan perlu dikali 100 jadi persen. */
export const ENKA_FRACTION_FIGHT_PROPS: ReadonlySet<string> = new Set([
  "3",
  "6",
  "9",
  "20",
  "22",
  "23",
  "26",
  "30",
  "40",
  "41",
  "42",
  "43",
  "44",
  "45",
  "46",
]);

/** mainPropId artifact (Enka) -> token kanonik KQM */
export const ENKA_MAIN_PROP_TO_KQM: Record<string, string> = {
  FIGHT_PROP_HP: "Flat HP",
  FIGHT_PROP_ATTACK: "Flat ATK",
  FIGHT_PROP_HP_PERCENT: "HP%",
  FIGHT_PROP_ATTACK_PERCENT: "ATK%",
  FIGHT_PROP_DEFENSE_PERCENT: "DEF%",
  FIGHT_PROP_CRITICAL: "CRIT Rate",
  FIGHT_PROP_CRITICAL_HURT: "CRIT DMG",
  FIGHT_PROP_CHARGE_EFFICIENCY: "ER",
  FIGHT_PROP_ELEMENT_MASTERY: "EM",
  FIGHT_PROP_HEAL_ADD: "Healing Bonus",
  FIGHT_PROP_PHYSICAL_ADD_HURT: "Physical DMG",
  FIGHT_PROP_FIRE_ADD_HURT: "Elemental DMG",
  FIGHT_PROP_WATER_ADD_HURT: "Elemental DMG",
  FIGHT_PROP_GRASS_ADD_HURT: "Elemental DMG",
  FIGHT_PROP_ELEC_ADD_HURT: "Elemental DMG",
  FIGHT_PROP_WIND_ADD_HURT: "Elemental DMG",
  FIGHT_PROP_ROCK_ADD_HURT: "Elemental DMG",
  FIGHT_PROP_ICE_ADD_HURT: "Elemental DMG",
};
