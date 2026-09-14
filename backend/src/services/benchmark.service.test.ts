import { test } from "node:test";
import assert from "node:assert/strict";
import { artifactContribution, buildReference, pickErTarget, referenceShowcase, type ReferenceBuild } from "./benchmark.service";
import { benchmarkConfig, loadBuffStore } from "./buffStore";
import type { ShowcaseCharacter } from "./enka.mapper";

const cfg = async () => {
  await loadBuffStore();
  return benchmarkConfig()!;
};

const build = { name: "Spread", sands: ["EM", "ATK%"], goblet: ["Elemental DMG"], circlet: ["CRIT"], substatPriority: ["ER", "CRIT Rate", "CRIT DMG", "EM"] };

test("buildReference: ER sampai target dulu, lalu CRIT (CR+CD dijaga rasio), cap 2/artifact tanpa main stat sama", async () => {
  const c = await cfg();
  // base tanpa artifact: CR 5, CD 50, ER 100; target 140 → butuh 40 − 2×5.51 (tetap) = 29 → 6 roll bebas
  const r = buildReference(build, c, { critRate: 5, critDmg: 50, er: 100 }, 140, "test", "CRIT Rate");
  assert.equal(r.mains.sands, "EM");
  assert.equal(r.mains.goblet, "Elemental DMG");
  assert.equal(r.mains.circlet, "CRIT Rate");
  assert.equal(r.substats.ER.liquid, 6);
  const liquidTotal = Object.values(r.substats).reduce((a, s) => a + s.liquid, 0);
  assert.equal(liquidTotal, c.liquidRolls);
  // CR cap = 2 × 4 artifact (circlet CR nggak ikut) = 8; EM cap 8 (sands EM)
  assert.ok(r.substats["CRIT Rate"].liquid <= 8);
  assert.ok(r.substats.EM.liquid <= 8);
  // rasio CR:CD acuan mendekati 1:2 (CR = 5 + 31.1 + roll, CD = 50 + roll)
  const cr = 5 + (r.contribution.stat.critRate ?? 0);
  const cd = 50 + (r.contribution.stat.critDmg ?? 0);
  assert.ok(Math.abs(cd / cr - 2) < 0.35, `rasio ${(cd / cr).toFixed(2)}`);
  assert.equal(r.contribution.dmg.self, c.mainStatValue["Elemental DMG"]);
  assert.ok(Math.abs((r.contribution.stat.hpFlat ?? 0) - (4780 + 2 * 253.94)) < 0.1);
});

test("buildReference: tanpa target ER → roll bebas nggak ke ER; 'CRIT DMG' circlet kalau diminta", async () => {
  const c = await cfg();
  const r = buildReference({ ...build, circlet: ["CRIT DMG"], substatPriority: ["ATK%", "CRIT"] }, c, { critRate: 5, critDmg: 50, er: 100 }, null, null);
  assert.equal(r.mains.circlet, "CRIT DMG");
  assert.equal(r.substats.ER.liquid, 0);
  assert.equal(r.substats["ATK%"].liquid, 10); // ATK% dulu sampai cap (2×5, nggak ada main ATK%)
  assert.equal(r.substats["CRIT Rate"].liquid + r.substats["CRIT DMG"].liquid, 10);
});

const sc: ShowcaseCharacter = {
  enkaAvatarId: 1,
  key: "HuTao",
  name: "Hu Tao",
  element: "Pyro",
  weaponType: "Polearm",
  supported: true,
  level: 90,
  ascension: 6,
  constellation: 0,
  weapon: { name: "Staff of Homa", level: 90, refinement: 1, baseAtk: 608, secondaryStat: "CRIT DMG" },
  talents: null,
  // total: HP% 46.6 (sands) + 5 (sub) + 20 (2pc set) = 71.6; CR 5 + 31.1 + 10 = 46.1; CD 50 + 66.2 (Homa) + 20 = 136.2
  stats: { critRate: 46.1, critDmg: 136.2, energyRecharge: 110, elementalMastery: 120, hpPercent: 71.6, atkPercent: 0, defPercent: 0, elementalDmgBonus: 46.6 },
  // base HP 15552 × 1.716 + 4780 + 500 = 31967 (dibulatkan)
  finalStats: { hp: Math.round(15552 * 1.716 + 4780 + 500), atk: 1000, def: 876 },
  baseStats: { hp: 15552, atk: 715, def: 876 },
  dmgBonus: { pyro: 46.6, hydro: 0, electro: 0, cryo: 0, dendro: 0, anemo: 0, geo: 0, physical: 0 },
  res: {},
  artifacts: [
    { slot: "flower", setName: "A", level: 20, rarity: 5, mainStat: { stat: "Flat HP", value: 4780 }, substats: [{ stat: "CRIT Rate", value: 10 }] },
    { slot: "plume", setName: "A", level: 20, rarity: 5, mainStat: { stat: "Flat ATK", value: 311 }, substats: [{ stat: "HP%", value: 5 }] },
    { slot: "sands", setName: "A", level: 20, rarity: 5, mainStat: { stat: "HP%", value: 46.6 }, substats: [{ stat: "Flat HP", value: 500 }] },
    { slot: "goblet", setName: "A", level: 20, rarity: 5, mainStat: { stat: "Elemental DMG", value: 46.6, element: "pyro" }, substats: [{ stat: "EM", value: 40 }] },
    { slot: "circlet", setName: "A", level: 20, rarity: 5, mainStat: { stat: "CRIT Rate", value: 31.1 }, substats: [{ stat: "ER", value: 10 }] },
  ],
  sets: [{ name: "A", count: 5 }],
  substatTotals: {},
  substatCritValue: 0,
};

test("artifactContribution: main + substat per StatKey, goblet DMG per elemen", () => {
  const c = artifactContribution(sc.artifacts);
  assert.equal(c.stat.hpFlat, 4780 + 500);
  assert.equal(c.stat.hpPercent, 46.6 + 5);
  assert.equal(c.stat.critRate, 41.1);
  assert.equal(c.stat.energyRecharge, 10);
  assert.deepEqual(c.dmg, { pyro: 46.6 });
});

test("referenceShowcase: round-trip — artifact acuan = artifact user → stat sama; ganti artifact → non-artifact tetap", () => {
  const same: ReferenceBuild = {
    buildName: null,
    mains: { flower: "Flat HP", plume: "Flat ATK", sands: "HP%", goblet: "Elemental DMG", circlet: "CRIT Rate" },
    substats: {} as ReferenceBuild["substats"],
    erTarget: null,
    erSource: null,
    contribution: { stat: artifactContribution(sc.artifacts).stat, dmg: { self: 46.6, physical: 0 } },
    artifacts: [],
    notes: [],
  };
  // substats kosong tapi kontribusi sama → total harus sama
  for (const t of ["CRIT Rate", "CRIT DMG", "ATK%", "HP%", "DEF%", "EM", "ER", "Flat ATK", "Flat HP", "Flat DEF"] as const)
    same.substats[t] = { fixed: 0, liquid: 0, value: 0 };
  const r = referenceShowcase(sc, same);
  assert.equal(r.finalStats.hp, sc.finalStats.hp);
  assert.equal(r.stats.critRate, sc.stats.critRate);
  assert.equal(r.stats.critDmg, sc.stats.critDmg);
  assert.equal(r.stats.energyRecharge, sc.stats.energyRecharge);
  assert.equal(r.dmgBonus.pyro, sc.dmgBonus.pyro);

  // acuan tanpa artifact sama sekali → sisa non-artifact: HP% 20 (set), CR 5, CD 136.2−0 (Homa+base), ER 100, pyro 0
  const none: ReferenceBuild = { ...same, contribution: { stat: {}, dmg: { self: 0, physical: 0 } } };
  const z = referenceShowcase(sc, none);
  assert.equal(z.stats.hpPercent, 20);
  assert.equal(z.stats.critRate, 5);
  assert.equal(z.stats.energyRecharge, 100);
  assert.equal(z.dmgBonus.pyro, 0);
  assert.equal(z.finalStats.hp, Math.round(15552 * 1.2));
});

test("pickErTarget: label > auto > arketipe terendah; kosong → null", () => {
  const reqs = [
    { label: "Solo Pyro C0", min: 160, max: 180 },
    { label: "With Favonius", min: 120, max: 140 },
  ];
  assert.equal(pickErTarget(reqs, sc, "favonius").target, 120);
  assert.equal(pickErTarget(reqs, sc).target, 120); // terendah (auto nggak yakin: senjata Homa, C0 ada di keduanya nggak)
  assert.equal(pickErTarget([], sc).target, null);
});
