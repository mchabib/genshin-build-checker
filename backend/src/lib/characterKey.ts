/** Turunkan key stabil dari nama Inggris karakter: "Hu Tao" -> "HuTao". */
export function deriveKey(nameEn: string): string {
  return nameEn.replace(/[^A-Za-z0-9]/g, "");
}

/** Element Enka store -> nama umum Genshin. */
export const ELEMENT_MAP: Record<string, string> = {
  Fire: "Pyro",
  Water: "Hydro",
  Grass: "Dendro",
  Electric: "Electro",
  Wind: "Anemo",
  Rock: "Geo",
  Ice: "Cryo",
};

/** WeaponType Enka store -> nama umum. */
export const WEAPON_MAP: Record<string, string> = {
  WEAPON_SWORD_ONE_HAND: "Sword",
  WEAPON_CLAYMORE: "Claymore",
  WEAPON_POLE: "Polearm",
  WEAPON_BOW: "Bow",
  WEAPON_CATALYST: "Catalyst",
};

export function qualityToRarity(quality: string): number {
  return quality === "QUALITY_PURPLE" ? 4 : 5;
}
