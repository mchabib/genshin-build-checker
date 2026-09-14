import { test } from "node:test";
import assert from "node:assert/strict";
import { inferReactions, parseKqmTeams, pickRotation, pickTeam, teamElements } from "./damage.rules";
import { loadBuffStore, parseWeaponValue, resolveModifier, type ExprContext } from "./buffStore";
import { comboDuration, parseKqmCombo, pickKqmCombo } from "../lib/kqmCombo";
import { rotationTimingFor, teamModifiers } from "./damage.run";
import type { CatalogCtx } from "../data/buffCatalog";
import type { StoredGuide } from "./guideStore";
import type { DamageCharacter } from "./damage.service";

const NAMES: Record<string, string> = { "hu tao": "HuTao", xingqiu: "Xingqiu", yelan: "Yelan", zhongli: "Zhongli", sucrose: "Sucrose", thoma: "Thoma" };
const resolve = (n: string) => NAMES[n.trim().toLowerCase()] ?? null;

const guide = {
  raw: { exampleTeams: "Hu Tao — Xingqiu — Yelan — Zhongli\nHu Tao — Xingqiu — Sucrose — Thoma\nteks panjang — bukan tim — karena kalimatnya kepanjangan sekali dan nggak ke-resolve" },
} as unknown as StoredGuide;

test("parseKqmTeams: baris 'A — B — C — D' → key tanpa diri sendiri, dedupe", () => {
  const t = parseKqmTeams(guide, resolve, "HuTao");
  assert.deepEqual(t, [["Xingqiu", "Yelan", "Zhongli"], ["Xingqiu", "Sucrose", "Thoma"]]);
});

test("pickTeam: preset modul menang kalau skor roster sama; skor = anggota di showcase", () => {
  const p = pickTeam({ key: "HuTao", self: [], teams: [["Xingqiu", "Yelan", "Zhongli"]] }, guide, resolve, "HuTao", ["Sucrose", "Thoma"]);
  assert.equal(p.source, "kqm"); // 2 anggota di roster > 0 + 0.5
  assert.deepEqual(p.keys, ["Xingqiu", "Sucrose", "Thoma"]);
  const p2 = pickTeam(null, null, resolve, "HuTao", []);
  assert.equal(p2.source, "none");
});

const hutao: DamageCharacter = {
  key: "HuTao", level: 90, element: "pyro",
  naElements: { na: "pyro", ca: "pyro", plunge: "pyro" },
  talentLevels: { normal: 10, skill: 10, burst: 10 },
  final: { hp: 30000, atk: 1500, def: 800, em: 100, critRate: 70, critDmg: 200 },
  base: { hp: 15552, atk: 800, def: 876 },
  dmgBonus: { pyro: 61.6, hydro: 0, electro: 0, cryo: 0, dendro: 0, anemo: 0, geo: 0, physical: 0 },
};

test("inferReactions: generik pyro+hydro → vaporize ca/skill/burst (NA nggak); modul override menang", () => {
  const g = inferReactions(null, hutao, ["pyro", "hydro", "geo"]);
  assert.deepEqual(g.reactions, { ca: "vaporize", skill: "vaporize", burst: "vaporize" });
  const m = inferReactions({ key: "HuTao", self: [], reactions: { with: { hydro: { na: "vaporize" } } } }, hutao, ["pyro", "hydro"]);
  assert.deepEqual(m.reactions, { na: "vaporize" });
  const none = inferReactions(null, hutao, ["pyro", "geo"]);
  assert.deepEqual(none.reactions, {});
  // NA physical nggak dapat reaksi
  const phys = inferReactions(null, { ...hutao, element: "electro", naElements: { na: "physical", ca: "physical", plunge: "physical" } }, ["electro", "dendro"]);
  assert.deepEqual(phys.reactions, { skill: "aggravate", burst: "aggravate" });
});

const HITS = [
  { id: "na1", kind: "na" }, { id: "na2", kind: "na" }, { id: "na3", kind: "na" }, { id: "na4", kind: "na" },
  { id: "ca1", kind: "ca" }, { id: "plunge1", kind: "plunge" }, { id: "plunge_low", kind: "plunge" }, { id: "plunge_high", kind: "plunge" },
  { id: "skill1", kind: "skill" }, { id: "skill2", kind: "skill" }, { id: "burst1", kind: "burst" },
] as never;

test("parseKqmCombo: N3CD, k[...] grup, E/Q ke semua hit skill/burst, plunge", () => {
  const p = parseKqmCombo("2[N4C] N2C", HITS);
  assert.deepEqual(p.counts, { na1: 3, na2: 3, na3: 2, na4: 2, ca1: 3 });
  const q = parseKqmCombo("Q + E + N3D N3CD", HITS);
  assert.deepEqual(q.counts, { burst1: 1, skill1: 1, skill2: 1, na1: 2, na2: 2, na3: 2, ca1: 1 });
  const x = parseKqmCombo("12[JhP] 2[JlP] 2[E]Q", HITS);
  assert.deepEqual(x.counts, { plunge_high: 12, plunge1: 14, plunge_low: 2, skill1: 2, skill2: 2, burst1: 1 });
  assert.equal(parseKqmCombo("N3 Z9", HITS).unknown.length, 1);
});

test("parseKqmCombo: actions modul menang atas default (Yae E = 5 turret, Sandrone C = 1+4 beam)", () => {
  const yae = parseKqmCombo("3[E]", HITS, { E: { skill1: 5 } });
  assert.deepEqual(yae.counts, { skill1: 15 });
  assert.ok(yae.hasSkill);
  const s = parseKqmCombo("3[C E] Q", HITS, { C: { ca1: 1, plunge1: 4 }, E: { skill1: 1 }, Q: { burst1: 1 } });
  assert.deepEqual(s.counts, { ca1: 3, plunge1: 12, skill1: 3, burst1: 1 });
  // N4 di-map ke hit burst (Raiden Musou Isshin)
  const r = parseKqmCombo("2[N4C]", HITS, { N4: { burst1: 4 }, C: { skill2: 1 } });
  assert.deepEqual(r.counts, { burst1: 8, skill2: 2 });
});

test("parseKqmCombo: limits aksi berurutan (Sandrone Decoding Power) — grup k[C E] per iterasi, E 3[C] kena overflow", () => {
  const actions = { C: { ca1: 1, plunge1: 3 }, E: { skill1: 1 } };
  const limits = { C: { max: 2, resetBy: ["E"], overflow: { ca1: 1, na1: 2 } } };
  // (C E)(C E)(C E): C nggak pernah berurutan > 2 → semua penuh
  const a = parseKqmCombo("3[C E]", HITS, actions, limits);
  assert.deepEqual(a.counts, { ca1: 3, plunge1: 9, skill1: 3 });
  // E C C C E C C C: C ke-3 tiap blok → overflow (ca1 tetap, na1 ×2, tanpa plunge1)
  const b = parseKqmCombo("E 3[C] E 3[C]", HITS, actions, limits);
  assert.deepEqual(b.counts, { skill1: 2, ca1: 6, plunge1: 12, na1: 4 });
  // tanpa limits → semua penuh
  assert.deepEqual(parseKqmCombo("E 3[C]", HITS, actions).counts, { skill1: 1, ca1: 3, plunge1: 9 });
});

test("comboDuration: timeline × tabel, prefix t/h/p fallback, N# ekstrapolasi, token nggak dikenal", () => {
  const p = parseKqmCombo("E 3[N3 C] hE Q Z", HITS);
  const table = { N1: 0.4, N2: 0.8, N3: 1.3, C: 1.1, E: 1.0, Q: 2.0 };
  const d = comboDuration(p.timeline, table);
  // E 1.0 + 3×(1.3 + 1.1) + hE→E 1.0 + Q 2.0 = 11.2
  assert.equal(d.total, 11.2);
  assert.deepEqual(d.rows.map((r) => [r.token, r.n, r.each]), [["E", 1, 1.0], ["N3", 3, 1.3], ["C", 3, 1.1], ["hE", 1, 1.0], ["Q", 1, 2.0]]);
  assert.deepEqual(d.unknown, []);
  // N5 nggak ada di tabel → N1 + 4 × (N2 − N1)
  const n5 = comboDuration([{ token: "N5", n: 2 }, { token: "JP", n: 1 }], table);
  assert.equal(n5.rows[0].each, 2);
  assert.deepEqual(n5.unknown, ["JP"]);
});

test("rotationTimingFor: --duration > preset duration > notasi; tanpa apa-apa → null", async () => {
  await loadBuffStore(); // _durations.json
  const mod = { key: "X", self: [], durations: { E: 0.9 } };
  const byNotation = rotationTimingFor({ kqm: "3[E] Q" }, HITS, mod, "Catalyst");
  assert.equal(byNotation.source, "notation");
  assert.equal(byNotation.duration, 3 * 0.9 + 2.0); // Q dari default _durations.json
  assert.equal(rotationTimingFor({ kqm: "3[E]", duration: 14 }, HITS, mod, "Catalyst").source, "module");
  assert.equal(rotationTimingFor({ kqm: "3[E]", duration: 14 }, HITS, mod, "Catalyst", 25).duration, 25);
  assert.equal(rotationTimingFor({ repeat: 9 }, HITS, null, "Sword").duration, null);
  // pengulangan dari prosa KQM ikut dikali
  const rep = rotationTimingFor({ kqm: "N1C", repeat: 9 }, HITS, null, "Polearm");
  assert.equal(rep.duration, Math.round(9 * (0.4 + 1.0) * 100) / 100);
});

test("teamModifiers: uptime nyata dari durasi talent (Bennett Q 12s/CD 15s) vs jendela rotasi; statis dikalikan", async () => {
  await loadBuffStore();
  const ctx: CatalogCtx = {
    char: hutao, key: "HuTao", constellation: 0, er: 100,
    team: { keys: ["Bennett", "Furina"], elements: ["pyro", "hydro"], count: 2, sameElementCount: 1 },
    sets4: [],
    talentParam: () => undefined,
    teammate: () => null,
    teammateParam: () => undefined,
    weaponValue: () => 0,
    talentMeta: () => ({}),
    teammateMeta: (k, slot) => (k === "Bennett" && slot === "burst" ? { duration: 12, cd: 15 } : k === "Furina" ? { duration: 18, cd: 15 } : {}),
  };
  const notes: string[] = [];
  const mods20 = teamModifiers(ctx, ["Bennett", "Furina"], ["pyro", "pyro", "hydro"], new Set(), false, undefined, [], 20, notes);
  const b20 = mods20.find((m) => m.id === "bennett_q")!;
  assert.equal(b20.uptime, 0.6); // 12 / max(20, 15)
  assert.equal(b20.uptimeSource, "duration");
  assert.deepEqual(notes, []);
  const f20 = mods20.find((m) => m.id === "furina_q")!;
  assert.equal(f20.uptime, 0.72); // statis 0.8 × 18/20
  // rotasi 10s < CD 15s → siklus 15s + catatan
  const mods10 = teamModifiers(ctx, ["Bennett"], ["pyro", "pyro"], new Set(), false, undefined, [], 10, notes);
  assert.equal(mods10.find((m) => m.id === "bennett_q")!.uptime, 0.8);
  assert.match(notes[0], /CD 15s > rotasi 10s/);
  // tanpa jendela → uptime apa adanya (statis / kosong)
  const none = teamModifiers(ctx, ["Bennett"], ["pyro", "pyro"], new Set(), false);
  assert.equal(none.find((m) => m.id === "bennett_q")!.uptime, undefined);
});

test("splitSegments: nama multi-kata + aksi", async () => {
  const { splitSegments } = await import("./rotation.run");
  const seg = splitSegments("Yae Miko 3[E] > Odette 2[E] > Qiqi E Q > Sandrone 3[C E] Q");
  assert.deepEqual(seg.map((s) => [s.name, s.notation]), [
    ["Yae Miko", "3[E]"],
    ["Odette", "2[E]"],
    ["Qiqi", "E Q"],
    ["Sandrone", "3[C E] Q"],
  ]);
});

test("pickKqmCombo: pilih baris notasi terlengkap, pengulangan dari prosa", () => {
  const raw = {
    combos: "N1C\nN1C refers to one Normal Attack then one Charged Attack. Players can still reach 9 N1C combos here.\nSome prose without notation.",
    overview: "E Q N3 bla",
  };
  const k = pickKqmCombo(raw, HITS);
  assert.ok(k);
  assert.equal(k!.notation, "N1C");
  assert.equal(k!.repeat, 9);
  assert.deepEqual(k!.counts, { na1: 9, ca1: 9 });
  const k2 = pickKqmCombo({ combos: "E 6[N3E]\nN1C spam Most recommended" }, HITS);
  assert.equal(k2!.notation, "E 6[N3E]");
  assert.equal(k2!.counts.skill1, 7);
});

test("pickRotation: preset modul (counts / kqm) → guide KQM → generik", () => {
  assert.equal(pickRotation({ key: "X", self: [], rotations: [{ label: "r", counts: { na1: 3 } }] }, HITS, null).source, "module");
  const m = pickRotation({ key: "X", self: [], rotations: [{ label: "r", kqm: "E 8[N1C] Q" }] }, HITS, null);
  assert.equal(m.source, "module");
  assert.deepEqual(m.counts, { skill1: 1, skill2: 1, na1: 8, ca1: 8, burst1: 1 });
  const guide = { raw: { combos: "3[N3C] N1C One of the highest damage ceilings" } } as unknown as StoredGuide;
  const k = pickRotation(null, HITS, guide);
  assert.equal(k.source, "kqm");
  assert.deepEqual(k.counts, { na1: 4, na2: 3, na3: 3, ca1: 4 });
  const g = pickRotation(null, HITS, null);
  assert.equal(g.source, "generic");
});

test("teamElements + parseWeaponValue", () => {
  assert.deepEqual(teamElements("pyro", ["Hydro", null, "Geo", "hydro"]), ["pyro", "hydro", "geo"]);
  assert.equal(parseWeaponValue("12/24/40%"), 40);
  assert.equal(parseWeaponValue("0.8%"), 0.8);
  assert.equal(parseWeaponValue(undefined), 0);
});

test("resolveModifier: ekspresi, $self, angka 0 dibuang", () => {
  const ctx: ExprContext = {
    char: hutao, con: 2, er: 150,
    p: (s, p) => (s === "skill" && p === "param2" ? 0.0626 : undefined),
    tp: () => 1.008,
    tm: (k) => (k === "Bennett" ? { baseAtk: 865, con: 1 } : null),
    team: { keys: ["Bennett"], elements: ["pyro"], count: 1, sameElementCount: 1 },
    wv: (i) => [3.2, 12][i] ?? 0,
    meta: () => ({ duration: 9, cd: 16 }),
    tmeta: (k, s) => (k === "Bennett" && s === "burst" ? { duration: 12, cd: 15 } : {}),
  };
  const m = resolveModifier("t", {
    source: "= 'ATK ' + tm('Bennett').baseAtk",
    scope: "all",
    atkFlat: "= round(tm('Bennett').baseAtk * (tp('Bennett','burst','param4') + (tm('Bennett').con >= 1 ? 0.2 : 0)))",
    elementalDmgBonus: { "$self": "= wv(1)" },
    atkFromStat: { stat: "hp", pct: "= pct(p('skill','param2'))", capPctOfBaseAtk: 400 },
    critDmg: "= con >= 6 ? 40 : 0",
  }, ctx, "pyro");
  assert.equal(m.source, "ATK 865");
  assert.equal(m.atkFlat, Math.round(865 * 1.208));
  assert.deepEqual(m.elementalDmgBonus, { pyro: 12 });
  assert.ok(Math.abs((m.atkFromStat?.pct ?? 0) - 6.26) < 1e-9);
  assert.equal("critDmg" in m, false);
});
