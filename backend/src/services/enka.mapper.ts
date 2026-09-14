import { resolveCharacter, resolveNameHash } from "./characterStore";
import { artifactSetNameFromIcon, weaponNameById } from "./gameDataStore";
import {
  ELEMENTS,
  ENKA_APPEND_PROP_TO_KEY,
  ENKA_ELEMENT_DMG_PROP,
  ENKA_ELEMENT_RES_PROP,
  ENKA_FIGHT_PROP_TO_KEY,
  ENKA_FRACTION_FIGHT_PROPS,
  ENKA_MAIN_PROP_TO_KQM,
  STAT_KEY_TO_KQM,
  type Element,
  type NormalizedStats,
  type StatKey,
} from "../lib/stats";
import type {
  EnkaAvatarInfo,
  EnkaFlatArtifact,
  EnkaFlatWeapon,
  EnkaResponse,
} from "./enka.types";

const EQUIP_TYPE_TO_SLOT: Record<string, string> = {
  EQUIP_BRACER: "flower",
  EQUIP_NECKLACE: "plume",
  EQUIP_SHOES: "sands",
  EQUIP_RING: "goblet",
  EQUIP_DRESS: "circlet",
};

export interface ShowcaseArtifact {
  slot: string;
  setName: string | null;
  level: number;
  rarity: number;
  /** token kanonik ala KQM: "HP%", "CRIT DMG", "Elemental DMG", "EM", "ER", ...; `element` cuma buat goblet DMG */
  mainStat: { stat: string; value: number; element?: Element };
  substats: { stat: string; value: number }[];
}

export interface ArtifactSetCount {
  name: string;
  count: number;
}

export interface ShowcaseWeapon {
  name: string | null;
  level: number;
  refinement: number; // 1-5
  /** base ATK senjata di level sekarang */
  baseAtk: number | null;
  /** secondary stat sebagai token kanonik, mis. "ER", "CRIT DMG", "EM" */
  secondaryStat: string | null;
}

export interface ShowcaseTalents {
  /** level dasar (yang di-upgrade pakai buku), tanpa bonus C3/C5 */
  normal: number;
  skill: number;
  burst: number;
  /** bonus level dari constellation (C3/C5 = +3), dari proudSkillExtraLevelMap */
  extra: { normal: number; skill: number; burst: number };
}

export interface ShowcaseCharacter {
  enkaAvatarId: number;
  key: string | null;
  name: string;
  element: string | null;
  weaponType: string | null;
  supported: boolean;
  level: number | null;
  /** ascension 0-6 (propMap 1002) */
  ascension: number | null;
  constellation: number; // 0-6
  weapon: ShowcaseWeapon | null;
  talents: ShowcaseTalents | null;
  /** total stat karakter (termasuk base), persen sebagai angka persen */
  stats: NormalizedStats;
  /** nilai final HP/ATK/DEF (sudah semua modifier) */
  finalStats: { hp: number; atk: number; def: number };
  /** base HP/ATK/DEF (karakter + base ATK senjata) — dasar buat hitung buff % (Fase 2) */
  baseStats: { hp: number; atk: number; def: number };
  /** DMG bonus per elemen, angka persen (fightProp 30, 40-46) */
  dmgBonus: Record<Element, number>;
  /** RES per elemen kalau Enka kasih (jarang), angka persen */
  res: Partial<Record<Element, number>>;
  artifacts: ShowcaseArtifact[];
  /** ringkasan set aktif, mis. [{ name: "Marechaussee Hunter", count: 4 }] */
  sets: ArtifactSetCount[];
  /** jumlah substat dari artifact saja (tanpa base), per StatKey */
  substatTotals: Partial<Record<StatKey, number>>;
  /** CV = CR*2 + CD dari substat artifact saja */
  substatCritValue: number;
}

function round(n: number, dp = 1): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

export function normalizeFightProps(
  fightPropMap: Record<string, number>,
): NormalizedStats {
  const out: NormalizedStats = {
    critRate: 0,
    critDmg: 0,
    energyRecharge: 0,
    elementalMastery: 0,
  };
  let maxElementalBonus = 0;

  for (const [id, rawValue] of Object.entries(fightPropMap)) {
    const key = ENKA_FIGHT_PROP_TO_KEY[id];
    if (!key) continue;
    const value = ENKA_FRACTION_FIGHT_PROPS.has(id) ? rawValue * 100 : rawValue;
    if (key === "elementalDmgBonus") {
      maxElementalBonus = Math.max(maxElementalBonus, value);
      continue;
    }
    (out as unknown as Record<string, number>)[key] = round(value, 1);
  }

  if (maxElementalBonus > 0) out.elementalDmgBonus = round(maxElementalBonus, 1);
  return out;
}

/** DMG bonus per elemen (persen), semua elemen selalu ada (0 kalau nggak ada). */
export function mapElementBonuses(
  fightPropMap: Record<string, number>,
): Record<Element, number> {
  const out = Object.fromEntries(ELEMENTS.map((e) => [e, 0])) as Record<Element, number>;
  for (const [id, el] of Object.entries(ENKA_ELEMENT_DMG_PROP)) {
    const v = fightPropMap[id];
    if (typeof v === "number") out[el] = round(v * 100, 1);
  }
  return out;
}

function mapResistances(
  fightPropMap: Record<string, number>,
): Partial<Record<Element, number>> {
  const out: Partial<Record<Element, number>> = {};
  for (const [id, el] of Object.entries(ENKA_ELEMENT_RES_PROP)) {
    const v = fightPropMap[id];
    if (typeof v === "number" && v !== 0) out[el] = round(v * 100, 1);
  }
  return out;
}

/** Level talent efektif = dasar + bonus C3/C5. */
export function effectiveTalentLevels(
  t: ShowcaseTalents | null,
): { normal: number; skill: number; burst: number } | null {
  if (!t) return null;
  return {
    normal: t.normal + t.extra.normal,
    skill: t.skill + t.extra.skill,
    burst: t.burst + t.extra.burst,
  };
}

/** mainPropId goblet DMG → elemen (buat benchmark: kontribusi goblet ke dmgBonus elemen mana) */
const MAIN_PROP_ELEMENT: Record<string, Element> = {
  FIGHT_PROP_PHYSICAL_ADD_HURT: "physical",
  FIGHT_PROP_FIRE_ADD_HURT: "pyro",
  FIGHT_PROP_WATER_ADD_HURT: "hydro",
  FIGHT_PROP_GRASS_ADD_HURT: "dendro",
  FIGHT_PROP_ELEC_ADD_HURT: "electro",
  FIGHT_PROP_WIND_ADD_HURT: "anemo",
  FIGHT_PROP_ROCK_ADD_HURT: "geo",
  FIGHT_PROP_ICE_ADD_HURT: "cryo",
};

function isArtifact(flat: unknown): flat is EnkaFlatArtifact {
  return (
    typeof flat === "object" &&
    flat !== null &&
    ("reliquaryMainstat" in (flat as object) || "reliquarySubstats" in (flat as object))
  );
}

function mapArtifacts(avatar: EnkaAvatarInfo): {
  artifacts: ShowcaseArtifact[];
  totals: Partial<Record<StatKey, number>>;
} {
  const artifacts: ShowcaseArtifact[] = [];
  const totals: Partial<Record<StatKey, number>> = {};

  for (const equip of avatar.equipList ?? []) {
    if (!equip.reliquary || !isArtifact(equip.flat)) continue;
    const flat = equip.flat;
    const slot = EQUIP_TYPE_TO_SLOT[flat.equipType ?? ""] ?? "unknown";

    const mainStat = flat.reliquaryMainstat
      ? ENKA_MAIN_PROP_TO_KQM[flat.reliquaryMainstat.mainPropId] ??
        flat.reliquaryMainstat.mainPropId
      : "unknown";

    const substats = (flat.reliquarySubstats ?? []).map((s) => {
      const key = ENKA_APPEND_PROP_TO_KEY[s.appendPropId];
      if (key) {
        totals[key] = round((totals[key] ?? 0) + s.statValue, 1);
      }
      return {
        stat: key ? STAT_KEY_TO_KQM[key] : s.appendPropId,
        value: round(s.statValue, 1),
      };
    });

    artifacts.push({
      slot,
      // hash loc.json dulu; item baru yang belum ada di loc → id set dari icon (dump genshin-db)
      setName: resolveNameHash(flat.setNameTextMapHash) ?? artifactSetNameFromIcon(flat.icon),
      level: equip.reliquary.level - 1, // Enka: level 21 = +20
      rarity: flat.rankLevel,
      mainStat: {
        stat: mainStat,
        value: flat.reliquaryMainstat
          ? round(flat.reliquaryMainstat.statValue, 1)
          : 0,
        element: flat.reliquaryMainstat ? MAIN_PROP_ELEMENT[flat.reliquaryMainstat.mainPropId] : undefined,
      },
      substats,
    });
  }

  return { artifacts, totals };
}

const WEAPON_SECONDARY_TO_KQM: Record<string, string> = {
  FIGHT_PROP_CHARGE_EFFICIENCY: "ER",
  FIGHT_PROP_CRITICAL: "CRIT Rate",
  FIGHT_PROP_CRITICAL_HURT: "CRIT DMG",
  FIGHT_PROP_ELEMENT_MASTERY: "EM",
  FIGHT_PROP_ATTACK_PERCENT: "ATK%",
  FIGHT_PROP_HP_PERCENT: "HP%",
  FIGHT_PROP_DEFENSE_PERCENT: "DEF%",
  FIGHT_PROP_PHYSICAL_ADD_HURT: "Physical DMG",
  FIGHT_PROP_HEAL_ADD: "Healing Bonus",
};

function mapWeapon(
  flat: EnkaFlatWeapon,
  weapon: { affixMap?: Record<string, number>; level?: number },
  itemId?: number,
): ShowcaseWeapon {
  const secondary = flat.weaponStats?.find(
    (s) => s.appendPropId !== "FIGHT_PROP_BASE_ATTACK",
  );
  const baseAtk = flat.weaponStats?.find(
    (s) => s.appendPropId === "FIGHT_PROP_BASE_ATTACK",
  );
  const affix = weapon.affixMap ? Object.values(weapon.affixMap)[0] : undefined;
  return {
    name: resolveNameHash(flat.nameTextMapHash) ?? weaponNameById(itemId),
    level: weapon.level ?? 0,
    refinement: affix != null ? affix + 1 : 1,
    baseAtk: baseAtk ? round(baseAtk.statValue, 0) : null,
    secondaryStat: secondary
      ? WEAPON_SECONDARY_TO_KQM[secondary.appendPropId] ?? null
      : null,
  };
}

function mapTalents(
  avatar: EnkaAvatarInfo,
  skillOrder: number[],
  proudMap: Record<string, number>,
): ShowcaseTalents | null {
  const m = avatar.skillLevelMap;
  if (!m) return null;
  // SkillOrder nggak diketahui (karakter baru di luar store Enka) → tebak: 3 id terkecil urut = NA, E, Q.
  // Berlaku buat mayoritas karakter; yang punya skill sprint (Ayaka/Mona) ada di store jadi nggak lewat sini.
  if (skillOrder.length < 3) {
    const ids = Object.keys(m).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (ids.length < 3) return null;
    skillOrder = ids.slice(0, 3);
  }
  const lvl = (id: number) => m[String(id)] ?? 0;
  // proudSkillExtraLevelMap di-key pakai proudSkillId, bukan skillId → lewat ProudMap
  const extraMap = avatar.proudSkillExtraLevelMap ?? {};
  const extra = (id: number) => {
    const proud = proudMap[String(id)];
    return proud != null ? extraMap[String(proud)] ?? 0 : 0;
  };
  return {
    normal: lvl(skillOrder[0]),
    skill: lvl(skillOrder[1]),
    burst: lvl(skillOrder[2]),
    extra: {
      normal: extra(skillOrder[0]),
      skill: extra(skillOrder[1]),
      burst: extra(skillOrder[2]),
    },
  };
}

function summariseSets(artifacts: ShowcaseArtifact[]): ArtifactSetCount[] {
  const counts = new Map<string, number>();
  for (const a of artifacts) {
    if (!a.setName) continue;
    counts.set(a.setName, (counts.get(a.setName) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((x, y) => y.count - x.count);
}

/** Bentuk artifact buat scorer (slot + main stat + substat, token kanonik). */
export function toArtifactInputs(c: ShowcaseCharacter) {
  return c.artifacts.map((a) => ({
    slot: a.slot,
    mainStat: a.mainStat.stat,
    substats: a.substats.map((s) => ({ stat: s.stat, value: s.value })),
  }));
}

export function mapShowcase(data: EnkaResponse): ShowcaseCharacter[] {
  const result: ShowcaseCharacter[] = [];

  for (const avatar of data.avatarInfoList ?? []) {
    const known = resolveCharacter(avatar.avatarId);
    const { artifacts, totals } = mapArtifacts(avatar);
    const levelRaw = avatar.propMap?.["4001"]?.val;
    const ascRaw = avatar.propMap?.["1002"];
    const ascensionRaw = ascRaw?.val ?? ascRaw?.ival;
    const fp = avatar.fightPropMap ?? {};

    const weaponEquip = (avatar.equipList ?? []).find((e) => e.weapon);
    const weapon =
      weaponEquip && "weaponStats" in weaponEquip.flat
        ? mapWeapon(weaponEquip.flat as EnkaFlatWeapon, weaponEquip.weapon!, weaponEquip.itemId)
        : null;

    result.push({
      enkaAvatarId: avatar.avatarId,
      key: known?.key ?? null,
      name: known?.name ?? `Avatar ${avatar.avatarId}`,
      element: known?.element ?? null,
      weaponType: known?.weaponType ?? null,
      supported: Boolean(known),
      level: levelRaw ? Number(levelRaw) : null,
      ascension: ascensionRaw != null ? Number(ascensionRaw) : null,
      constellation: avatar.talentIdList?.length ?? 0,
      weapon,
      talents: mapTalents(avatar, known?.skillOrder ?? [], known?.proudMap ?? {}),
      stats: normalizeFightProps(fp),
      finalStats: {
        hp: round(fp["2000"] ?? 0, 0),
        atk: round(fp["2001"] ?? 0, 0),
        def: round(fp["2002"] ?? 0, 0),
      },
      baseStats: {
        hp: round(fp["1"] ?? 0, 0),
        atk: round(fp["4"] ?? 0, 0),
        def: round(fp["7"] ?? 0, 0),
      },
      dmgBonus: mapElementBonuses(fp),
      res: mapResistances(fp),
      artifacts,
      sets: summariseSets(artifacts),
      substatTotals: totals,
      substatCritValue: round((totals.critRate ?? 0) * 2 + (totals.critDmg ?? 0), 1),
    });
  }

  return result;
}
