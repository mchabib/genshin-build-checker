import type { Element } from "../lib/stats";
import type { HitKind } from "../services/damage.types";

/**
 * Elemen NA/CA/plunge per karakter yang punya infusion sendiri (dari E/Q/passive).
 * Aturan default (kalau nggak ada di sini): catalyst → elemen sendiri, sisanya physical.
 * LLM boleh override lewat `naInfusion` (mis. Chongyun/Candace infuse ke orang lain).
 * `scope` = jenis hit yang kena infusion; sisanya tetap physical.
 */
export interface InfusionRule {
  element: Element;
  scope: HitKind[];
  note: string;
}

const ALL: HitKind[] = ["na", "ca", "plunge"];

export const INFUSIONS: Record<string, InfusionRule> = {
  HuTao: { element: "pyro", scope: ALL, note: "Paramita Papilio (E)" },
  Diluc: { element: "pyro", scope: ALL, note: "Dawn (Q)" },
  KamisatoAyaka: { element: "cryo", scope: ALL, note: "Alternate Sprint" },
  Chongyun: { element: "cryo", scope: ALL, note: "Chonghua's Layered Frost (E)" },
  KamisatoAyato: { element: "hydro", scope: ["na"], note: "Takimeguri Kanka (E)" },
  Keqing: { element: "electro", scope: ALL, note: "Stellar Restoration (E recast)" },
  Xiao: { element: "anemo", scope: ALL, note: "Bane of All Evil (Q)" },
  Cyno: { element: "electro", scope: ALL, note: "Pactsworn Pathclearer (Q)" },
  Alhaitham: { element: "dendro", scope: ALL, note: "Mirror (E)" },
  Arlecchino: { element: "pyro", scope: ALL, note: "Masque of the Red Death (A1)" },
  Clorinde: { element: "electro", scope: ALL, note: "Night Watch (E)" },
  RaidenShogun: { element: "electro", scope: ALL, note: "Musou Isshin (Q)" },
  Tartaglia: { element: "hydro", scope: ALL, note: "Foul Legacy (E)" },
  Mavuika: { element: "pyro", scope: ALL, note: "Flamestrider (E)" },
  Navia: { element: "geo", scope: ALL, note: "As the Sunlit Sky's Singing Salute (Q)" },
  Wanderer: { element: "anemo", scope: ALL, note: "Windfavored (E)" },
  Gaming: { element: "pyro", scope: ["plunge"], note: "Charmed Cloudstrider (E)" },
  Xianyun: { element: "anemo", scope: ["plunge"], note: "catalyst" },
  Eula: { element: "physical", scope: ALL, note: "physical DPS" },
  Chasca: { element: "anemo", scope: ["ca"], note: "Soulsniper (E) multi-target CA" },
  Flins: { element: "electro", scope: ALL, note: "Night-Ruler (E)" },
  Dehya: { element: "pyro", scope: ALL, note: "Leonine Bite (Q) — Q punches" },
  Yelan: { element: "hydro", scope: ["ca"], note: "Breakthrough Barb" },
  Yoimiya: { element: "pyro", scope: ["na"], note: "Niwabi Fire-Dance (E)" },
  Wriothesley: { element: "cryo", scope: ALL, note: "catalyst" },
  Kinich: { element: "dendro", scope: ALL, note: "Nightsoul (E)" },
  Ororon: { element: "electro", scope: ["ca"], note: "bow CA" },
  Varesa: { element: "electro", scope: ALL, note: "catalyst" },
  Skirk: { element: "cryo", scope: ALL, note: "Seven-Phase Flash (E)" },
  Emilie: { element: "dendro", scope: [], note: "polearm, NA physical" },
  Neuvillette: { element: "hydro", scope: ALL, note: "catalyst" },
};

export function defaultNaElement(
  key: string | null,
  element: Element | null,
  weaponType: string | null,
  kind: HitKind,
): Element {
  const rule = key ? INFUSIONS[key] : undefined;
  if (rule && rule.scope.includes(kind)) return rule.element;
  if (weaponType === "Catalyst" && element) return element;
  return "physical";
}
