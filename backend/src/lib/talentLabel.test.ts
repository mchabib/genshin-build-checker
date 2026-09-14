import { test } from "node:test";
import assert from "node:assert/strict";
import { multiplierAt, parseTalentHits, parseTalentMeta } from "./talentLabel";

const P = (n: number) => Array.from({ length: 15 }, (_, i) => n * (1 + i * 0.1));

test("label NA sederhana → 1 hit ATK", () => {
  const { hits, warnings } = parseTalentHits("normal", {
    labels: ["1-Hit DMG|{param1:F1P}", "Charged Attack Stamina Cost|{param9:F1}"],
    parameters: { param1: P(0.5), param9: P(25) },
  });
  assert.equal(warnings.length, 0);
  assert.equal(hits.length, 1);
  assert.deepEqual({ id: hits[0].id, kind: hits[0].kind, stat: hits[0].scalings[0].stat }, { id: "na1", kind: "na", stat: "atk" });
});

test("Hu Tao: 'Charged Attack' tanpa kata DMG tetap hit CA; Low/High plunge jadi 2 hit", () => {
  const { hits } = parseTalentHits("normal", {
    labels: ["Charged Attack|{param8:F1P}", "Plunge DMG|{param10:F1P}", "Low/High Plunge DMG|{param11:P}/{param12:P}"],
    parameters: { param8: P(2.4), param10: P(1.1), param11: P(2.3), param12: P(2.9) },
  });
  assert.deepEqual(
    hits.map((h) => [h.id, h.kind, h.label]),
    [
      ["ca1", "ca", "Charged Attack"],
      ["plunge1", "plunge", "Plunge DMG"],
      ["plunge_low", "plunge", "Low Plunge DMG"],
      ["plunge_high", "plunge", "High Plunge DMG"],
    ],
  );
});

test("multi-bagian ATK + EM dan ×N", () => {
  const { hits } = parseTalentHits("skill", {
    labels: ["2-Mirror Projection Attack DMG|({param6:F1P} ATK+{param7:F1P} Elemental Mastery)×2"],
    parameters: { param6: P(0.67), param7: P(1.34) },
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].hitCount, 2);
  assert.deepEqual(hits[0].scalings.map((s) => s.stat), ["atk", "em"]);
  assert.equal(hits[0].id, "skill1");
});

test("HP scaling + ×3 (Yelan burst)", () => {
  const { hits } = parseTalentHits("burst", {
    labels: ["Skill DMG|{param1:F2P} Max HP", "Exquisite Throw DMG|{param2:F2P} Max HP ×3"],
    parameters: { param1: P(0.07), param2: P(0.05) },
  });
  assert.deepEqual(hits.map((h) => [h.id, h.scalings[0].stat, h.hitCount]), [["burst1", "hp", 1], ["burst2", "hp", 3]]);
});

test("label non-hit di-skip (Bonus/Duration/CD/Cost), scaling nggak dikenal → warning", () => {
  const { hits, warnings } = parseTalentHits("skill", {
    labels: [
      "Skill DMG|{param1:F1P}",
      "Duration|{param5:F1}s",
      "CD|{param6:F1}s",
      "Elemental Burst DMG Bonus|{param4:F2P} Per Energy",
      "Kuugo: Fushoudan DMG|{param2:F1P} Normal Attack DMG",
    ],
    parameters: { param1: P(1), param5: P(9), param6: P(16), param4: P(0.003), param2: P(1.5) },
  });
  assert.equal(hits.length, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].reason, /scaling nggak dikenal/);
});

test("alternatif '/' tanpa Low/High → id a/b, plunge di slot burst dapat prefix", () => {
  const { hits } = parseTalentHits("skill", {
    labels: ["Stone Stele/Resonance DMG|{param1:F1P}/{param2:F1P}"],
    parameters: { param1: P(0.16), param2: P(0.32) },
  });
  assert.deepEqual(hits.map((h) => [h.id, h.label]), [["skill1a", "Stone Stele DMG"], ["skill1b", "Resonance DMG"]]);

  const burst = parseTalentHits("burst", {
    labels: ["Low/High Plunge DMG|{param15:P}/{param16:P}"],
    parameters: { param15: P(2.5), param16: P(3.1) },
  });
  assert.deepEqual(burst.hits.map((h) => h.id), ["burst_plunge_low", "burst_plunge_high"]);
});

test("multiplierAt clamp level", () => {
  const v = [1, 2, 3];
  assert.equal(multiplierAt(v, 0), 1);
  assert.equal(multiplierAt(v, 2), 2);
  assert.equal(multiplierAt(v, 13), 3);
});

test("parseTalentMeta: Duration/CD dari token param, alternatif '/', teks polos; 'Shield Duration' diabaikan", () => {
  const m = parseTalentMeta(
    {
      labels: ["Skill DMG|{param1:P}", "Duration|{param5:F1}s", "CD|{param7:F1}/{param8:F1}/{param9:F1}s", "Energy Cost|{param9:I}"],
      parameters: { param1: [2.3], param5: [12, 12], param7: [5, 5], param8: [7.5, 7.5], param9: [60] },
    },
    10,
  );
  assert.deepEqual(m, { duration: 12, cd: 5 });
  const plain = parseTalentMeta({ labels: ["Shield Duration|20s", "Cooldown|12s"], parameters: {} }, 1);
  assert.deepEqual(plain, { cd: 12 });
  assert.deepEqual(parseTalentMeta(undefined, 1), {});
});
