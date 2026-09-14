/** Subset tipe response Enka.Network yang kita pakai. */

export interface EnkaReliquarySubstat {
  appendPropId: string;
  statValue: number;
}

export interface EnkaFlatArtifact {
  nameTextMapHash: string;
  rankLevel: number;
  reliquaryMainstat?: { mainPropId: string; statValue: number };
  reliquarySubstats?: EnkaReliquarySubstat[];
  setNameTextMapHash?: string;
  equipType?: string; // EQUIP_BRACER | EQUIP_NECKLACE | EQUIP_SHOES | EQUIP_RING | EQUIP_DRESS
  icon?: string;
}

export interface EnkaFlatWeapon {
  nameTextMapHash: string;
  rankLevel: number;
  weaponStats?: { appendPropId: string; statValue: number }[];
  itemType: "ITEM_WEAPON";
  icon?: string;
}

export interface EnkaEquip {
  itemId: number;
  reliquary?: { level: number; mainPropId: number; appendPropIdList?: number[] };
  weapon?: { level: number; promoteLevel?: number; affixMap?: Record<string, number> };
  flat: EnkaFlatArtifact | EnkaFlatWeapon;
}

export interface EnkaAvatarInfo {
  avatarId: number;
  propMap?: Record<string, { type: number; ival?: string; val?: string }>;
  talentIdList?: number[];
  fightPropMap: Record<string, number>;
  skillLevelMap?: Record<string, number>;
  /** proudSkillId -> bonus level talent dari C3/C5 (cuma ada kalau punya) */
  proudSkillExtraLevelMap?: Record<string, number>;
  equipList?: EnkaEquip[];
}

export interface EnkaPlayerInfo {
  nickname?: string;
  level?: number;
  signature?: string;
  worldLevel?: number;
  showAvatarInfoList?: { avatarId: number; level: number }[];
}

export interface EnkaResponse {
  playerInfo?: EnkaPlayerInfo;
  avatarInfoList?: EnkaAvatarInfo[];
  ttl?: number;
  uid?: string;
}

export class EnkaError extends Error {
  constructor(
    public code:
      | "INVALID_UID"
      | "NOT_FOUND"
      | "SHOWCASE_EMPTY"
      | "RATE_LIMITED"
      | "MAINTENANCE"
      | "UPSTREAM_ERROR",
    message: string,
    public status = 502,
    public retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "EnkaError";
  }
}
