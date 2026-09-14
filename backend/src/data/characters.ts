/**
 * Daftar karakter PoC untuk Fase 1.
 * enkaAvatarId = avatarId Enka.Network. Base stat (Fase 2) belum diisi.
 *
 * TODO Fase 1: ganti daftar hardcoded ini dengan loader dari Enka store
 * (https://raw.githubusercontent.com/EnkaNetwork/API-docs/master/store/characters.json + loc.json)
 * biar semua karakter ke-cover.
 */
export interface CharacterSeed {
  key: string;
  enkaAvatarId: number;
  name: string;
  element: string;
  weaponType: string;
  rarity: number;
}

export const CHARACTERS: CharacterSeed[] = [
  { key: "HuTao", enkaAvatarId: 10000046, name: "Hu Tao", element: "Pyro", weaponType: "Polearm", rarity: 5 },
  { key: "RaidenShogun", enkaAvatarId: 10000052, name: "Raiden Shogun", element: "Electro", weaponType: "Polearm", rarity: 5 },
  { key: "Nahida", enkaAvatarId: 10000073, name: "Nahida", element: "Dendro", weaponType: "Catalyst", rarity: 5 },
  { key: "Bennett", enkaAvatarId: 10000032, name: "Bennett", element: "Pyro", weaponType: "Sword", rarity: 4 },
  { key: "Xiangling", enkaAvatarId: 10000023, name: "Xiangling", element: "Pyro", weaponType: "Polearm", rarity: 4 },
  { key: "Xingqiu", enkaAvatarId: 10000025, name: "Xingqiu", element: "Hydro", weaponType: "Sword", rarity: 4 },
  { key: "KaedeharaKazuha", enkaAvatarId: 10000047, name: "Kaedehara Kazuha", element: "Anemo", weaponType: "Sword", rarity: 5 },
  { key: "Ganyu", enkaAvatarId: 10000037, name: "Ganyu", element: "Cryo", weaponType: "Bow", rarity: 5 },
  { key: "Yelan", enkaAvatarId: 10000060, name: "Yelan", element: "Hydro", weaponType: "Bow", rarity: 5 },
  { key: "Furina", enkaAvatarId: 10000089, name: "Furina", element: "Hydro", weaponType: "Sword", rarity: 5 },
];

export const CHARACTER_BY_ENKA_ID: Map<number, CharacterSeed> = new Map(
  CHARACTERS.map((c) => [c.enkaAvatarId, c]),
);
