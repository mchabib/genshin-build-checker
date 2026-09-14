/**
 * Stellar Glimmer (Stellar-Conduct / Stellar Swirl) — mekanik reaksi v6.7+.
 * Sumber: guide KQM https://keqingmains.com/misc/stellar/ (tabel Reaction Multiplier & aturan bonus).
 *
 * Reaksinya sendiri NGGAK ngasih damage; yang ada = hit talent karakter ber-label "… Stellar-Conduct DMG".
 * Rumus hit Stellar-Conduct:
 *   ATK × MV × coef(hits) × (1 + EMbonus + StellarBaseDmgBonus) × RES × crit
 *   - coef: jumlah hit Cryo/Electro yang direkam Polestar Field per siklus 4s: 0 → 1.0, n≥1 → 1.4 + 0.05n (max 12 → 2.0)
 *   - TANPA multiplier DEF musuh, TANPA DMG% biasa (goblet, Furina, dsb)
 *   - EM bonus: diasumsikan formula kelas Lunar 6·EM/(EM+2000) (guide cuma nampilin gambar rumus) → kalibrasi kalau meleset
 * Polestar Field (7s, siklus 4s) juga ngasih tim Cryo+Electro DMG +20–40% (ini DMG% biasa → berlaku ke hit non-Stellar)
 * dan Physical RES musuh −40% — dimodelkan sebagai entry `polestar_field` di scrape-data/Buffs/_team.json.
 */

/** default jumlah hit terekam per siklus 4s — tim Stellar penuh (turret Yae + Cryo terus) gampang 8+ */
export const DEFAULT_STELLAR_HITS = 8;

export function stellarConductCoef(hits: number): number {
  const n = Math.max(0, Math.min(12, Math.round(hits)));
  return n === 0 ? 1 : Math.round((1.4 + 0.05 * n) * 100) / 100;
}

export function stellarEmBonus(em: number): number {
  return (6 * em) / (em + 2000);
}
