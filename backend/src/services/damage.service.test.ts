import { test } from "node:test";
import assert from "node:assert/strict";
import {
  additiveBase,
  ampMultiplier,
  computeHit,
  computeRotation,
  computeTalentTable,
  defMultiplier,
  defaultEnemy,
  resMultiplier,
  transformativeDmg,
  type DamageCharacter,
  type DamageInput,
} from "./damage.service";
import type { HitDef, Modifier } from "./damage.types";

const close = (a: number, b: number, tol = 0.5) =>
  assert.ok(Math.abs(a - b) <= tol, `expected ${a} ≈ ${b} (±${tol})`);

test("resMultiplier: 3 rentang", () => {
  close(resMultiplier(0.1), 0.9, 1e-9);
  close(resMultiplier(-0.3), 1.15, 1e-9);
  close(resMultiplier(0.9), 1 / 4.6, 1e-9);
});

test("defMultiplier lv90 vs lv90 = 0.5; Raiden C2 60% ignore", () => {
  close(defMultiplier(90, 90), 0.5, 1e-9);
  close(defMultiplier(90, 90, 0, 60), 190 / (190 + 190 * 0.4), 1e-9);
});

test("amplifying: vape pyro 1.5, vape hydro 2, melt cryo 1.5, EM bonus", () => {
  close(ampMultiplier("vaporize", "pyro", 0), 1.5, 1e-9);
  close(ampMultiplier("vaporize", "hydro", 0), 2, 1e-9);
  close(ampMultiplier("melt", "cryo", 0), 1.5, 1e-9);
  close(ampMultiplier("vaporize", "pyro", 100, 15), 1.5 * (1 + (2.78 * 100) / 1500 + 0.15), 1e-9);
});

test("additive aggravate lv90 EM0 = 1446.85 × 1.15", () => {
  close(additiveBase("aggravate", 90, 0), 1446.853458 * 1.15, 0.01);
  close(additiveBase("spread", 90, 200), 1446.853458 * 1.25 * (1 + 1000 / 1400), 0.01);
});

test("transformative overloaded lv90", () => {
  const r = transformativeDmg("overloaded", 90, 0, 0, 0.9);
  close(r.dmg, 1446.853458 * 2.75 * 0.9, 0.01);
  const r2 = transformativeDmg("hyperbloom", 90, 800, 0, 0.9);
  close(r2.dmg, 1446.853458 * 3 * (1 + (16 * 800) / 2800) * 0.9, 0.01);
});

// ---------- Hu Tao CA hand-calc ----------
const hutao: DamageCharacter = {
  key: "HuTao",
  level: 90,
  element: "pyro",
  naElements: { na: "pyro", ca: "pyro", plunge: "pyro" },
  talentLevels: { normal: 10, skill: 10, burst: 10 },
  final: { hp: 30000, atk: 1500, def: 800, em: 100, critRate: 70, critDmg: 200 },
  base: { hp: 15552, atk: 800, def: 876 },
  dmgBonus: { pyro: 61.6, hydro: 0, electro: 0, cryo: 0, dendro: 0, anemo: 0, geo: 0, physical: 0 },
};
const ca: HitDef = {
  id: "ca1",
  label: "Charged Attack",
  kind: "ca",
  slot: "normal",
  scalings: [{ stat: "atk", values: Array(15).fill(2.4265) }],
  hitCount: 1,
};
const e: Modifier = {
  source: "Hu Tao E",
  scope: "all",
  atkFromStat: { stat: "hp", pct: 6.26, capPctOfBaseAtk: 400 },
};

test("hit Stellar-Conduct: coef(hits), EM bonus + stellarBonus, tanpa DEF & tanpa DMG% biasa", () => {
  const hit: HitDef = { id: "ca3", label: "Condensed Beam Stellar-Conduct DMG", kind: "ca", slot: "normal", scalings: [{ stat: "atk", values: [1] }], hitCount: 1, stellar: "conduct" };
  const char: DamageCharacter = {
    key: "X", level: 90, element: "cryo", naElements: { na: "cryo", ca: "cryo", plunge: "cryo" },
    talentLevels: { normal: 1, skill: 1, burst: 1 },
    final: { hp: 1, atk: 1000, def: 1, em: 0, critRate: 0, critDmg: 0 },
    base: { hp: 1, atk: 1000, def: 1 },
    dmgBonus: { pyro: 0, hydro: 0, electro: 0, cryo: 100, dendro: 0, anemo: 0, geo: 0, physical: 0 },
  };
  const mods: Modifier[] = [{ source: "s", scope: "all", stellarBonus: 40, dmgBonus: 50 }];
  const enemy = defaultEnemy(90, 0);
  const r = computeHit(hit, { char, hits: [hit], modifiers: mods, reactions: {}, enemy, stellarHits: 8 }, []);
  // 1000 × 1.0 × coef 1.8 × (1 + 0 EM + 0.4) — goblet cryo 100% & dmgBonus 50 diabaikan, DEF nggak dipakai
  assert.ok(Math.abs(r.nonCrit - 1000 * 1.8 * 1.4) < 0.01, String(r.nonCrit));
  assert.equal(r.breakdown.defMult, 1);
  assert.equal(r.breakdown.stellar?.coef, 1.8);
  const r0 = computeHit(hit, { char, hits: [hit], modifiers: [], reactions: {}, enemy, stellarHits: 0 }, []);
  assert.ok(Math.abs(r0.nonCrit - 1000) < 0.01);
  const em = computeHit(hit, { char: { ...char, final: { ...char.final, em: 2000 } }, hits: [hit], modifiers: [], reactions: {}, enemy, stellarHits: 12 }, []);
  assert.ok(Math.abs(em.nonCrit - 1000 * 2.0 * (1 + 3)) < 0.01); // 6·2000/(4000) = 3
});

test("Hu Tao CA: ATK dari HP, no reaction", () => {
  const input: DamageInput = { char: hutao, hits: [ca], modifiers: [e], reactions: {}, enemy: defaultEnemy() };
  const r = computeHit(ca, input, []);
  const atk = 1500 + 30000 * 0.0626; // 3378, di bawah cap 3200? cap = 400% × 800 = 3200 → gain 1878 < 3200 OK
  const expect = atk * 2.4265 * 1.616 * 0.5 * 0.9;
  close(r.nonCrit, expect, 0.5);
  close(r.crit, expect * 3, 0.5);
  close(r.avg, expect * (1 + 0.7 * 2), 0.5);
  assert.equal(r.element, "pyro");
});

test("Hu Tao CA vaporize + CW 4pc reaction bonus", () => {
  const cw: Modifier = { source: "CW", scope: "all", reactionBonus: { vaporize: 15 }, elementalDmgBonus: { pyro: 22.5 } };
  const input: DamageInput = { char: hutao, hits: [ca], modifiers: [e, cw], reactions: { ca: "vaporize" }, enemy: defaultEnemy() };
  const r = computeHit(ca, input, []);
  const atk = 1500 + 30000 * 0.0626;
  const amp = 1.5 * (1 + (2.78 * 100) / 1500 + 0.15);
  close(r.nonCrit, atk * 2.4265 * (1 + 0.616 + 0.225) * 0.5 * 0.9 * amp, 0.5);
  assert.equal(r.reaction, "vaporize");
});

test("reaksi nggak cocok elemen → diabaikan + warning", () => {
  const warnings: string[] = [];
  const input: DamageInput = { char: hutao, hits: [ca], modifiers: [], reactions: { ca: "aggravate" }, enemy: defaultEnemy() };
  const r = computeHit(ca, input, warnings);
  assert.equal(r.reaction, null);
  assert.equal(warnings.length, 1);
});

test("scope & hitIds: buff burst nggak kena NA; hitIds spesifik", () => {
  const na: HitDef = { ...ca, id: "na1", kind: "na", label: "1-Hit" };
  const burstOnly: Modifier = { source: "Emblem", scope: "burst", dmgBonus: 75 };
  const onlyCa: Modifier = { source: "x", scope: "all", hitIds: ["ca1"], talentMultAdd: 100 };
  const base = computeHit(na, { char: hutao, hits: [na], modifiers: [], reactions: {}, enemy: defaultEnemy() }, []);
  const withBurst = computeHit(na, { char: hutao, hits: [na], modifiers: [burstOnly], reactions: {}, enemy: defaultEnemy() }, []);
  close(base.nonCrit, withBurst.nonCrit, 1e-6);
  const caHit = computeHit(ca, { char: hutao, hits: [ca], modifiers: [onlyCa], reactions: {}, enemy: defaultEnemy() }, []);
  const naHit = computeHit(na, { char: hutao, hits: [na], modifiers: [onlyCa], reactions: {}, enemy: defaultEnemy() }, []);
  close(caHit.nonCrit / base.nonCrit, (2.4265 + 1) / 2.4265, 1e-6);
  close(naHit.nonCrit, base.nonCrit, 1e-6);
});

test("uptime menskala buff linear; resShred negatif → res mult > 1", () => {
  const vv: Modifier = { source: "VV", scope: "all", resShred: { pyro: 40 }, uptime: 0.5 };
  const input: DamageInput = { char: hutao, hits: [ca], modifiers: [vv], reactions: {}, enemy: defaultEnemy() };
  const r = computeHit(ca, input, []);
  // res 10% - 20% (40 × 0.5) = -10% → 1 + 0.05
  close(r.breakdown.resMult, 1.05, 1e-9);
});

test("tabel + rotasi + transformative", () => {
  const input: DamageInput = {
    char: hutao,
    hits: [ca],
    modifiers: [e],
    reactions: { ca: "vaporize", skill: "overloaded" },
    enemy: defaultEnemy(),
  };
  const table = computeTalentTable(input);
  assert.equal(table.hits.length, 1);
  assert.equal(table.transformative.length, 1);
  assert.equal(table.transformative[0].reaction, "overloaded");
  const rot = computeRotation(table, "test", { ca1: 2, "react:overloaded": 1, nope: 3 }, input);
  assert.equal(rot.rows.length, 2);
  assert.equal(rot.warnings.length, 1);
  close(rot.total, table.hits[0].avg * 2 + table.transformative[0].dmg, 0.01);
});
