import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkBuffs } from "./buffCheck.service";

test("check:buffs — data scrape-data/Buffs sekarang bebas error", async () => {
  const issues = await checkBuffs();
  const errors = issues.filter((i) => i.level === "error");
  assert.deepEqual(errors, [], `error di Buffs:\n${errors.map((e) => `  ${e.file} › ${e.where}: ${e.message}`).join("\n")}`);
});

test("check:buffs — nangkep hit id salah, field mod typo, ekspresi nggak null-safe, set/senjata/karakter nggak ada, token durasi", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "buffs-"));
  await fs.writeFile(
    path.join(dir, "_team.json"),
    JSON.stringify([
      { id: "t1", fromCharacter: "NggakAda", description: "", mod: { source: "x", scope: "all", atkFlat: "= tm('Bennett').baseAtk * 1.2" } },
      { id: "t1", fromCharacter: "Bennett", description: "dup", mod: { source: "x", scope: "semua", atkPcnt: 20 } },
    ]),
  );
  await fs.writeFile(path.join(dir, "_sets.json"), JSON.stringify([{ id: "s1", set: "Set Khayalan", description: "", mod: { scope: "all", dmgBonus: 10 } }]));
  await fs.writeFile(path.join(dir, "_weapons.json"), JSON.stringify([{ id: "w1", weapon: "Pedang Khayalan", description: "", mod: { scope: "all", wv: 1, atkPct: "= wv(0)" } }]));
  await fs.writeFile(path.join(dir, "_durations.json"), JSON.stringify({ default: { N1: 0.5, X9: 1 } }));
  await fs.writeFile(
    path.join(dir, "HuTao.json"),
    JSON.stringify({
      key: "HuTao",
      role: "dps",
      self: [{ id: "h1", description: "", mode: "kadang", mod: { scope: "ca", hitIds: ["ca9"], atkFromStat: { stat: "hp", pct: 6 } } }],
      actions: { E: { skill99: 1 } },
      rotations: [{ label: "r", counts: { na1: 9, zzz: 1 } }, { label: "k", kqm: "N2C Z9" }],
      durations: { QQ: 1 },
    }),
  );
  await fs.writeFile(path.join(dir, "rusak.json"), "{ ini bukan json");

  const issues = await checkBuffs(dir);
  const msgs = issues.map((i) => `${i.level}:${i.file}:${i.where}:${i.message}`);
  const has = (re: RegExp) => assert.ok(msgs.some((m) => re.test(m)), `nggak ada issue cocok ${re}\n${msgs.join("\n")}`);
  has(/error:_team.json:t1:fromCharacter "NggakAda"/);
  has(/error:_team.json:t1:ekspresi gagal \(teammate nggak ada/);
  has(/error:_team.json:t1:id duplikat/);
  has(/error:_team.json:t1:scope "semua"/);
  has(/error:_team.json:t1:field mod nggak dikenal: `atkPcnt`/);
  has(/error:_sets.json:s1:set "Set Khayalan"/);
  has(/error:_weapons.json:w1:senjata "Pedang Khayalan"/);
  has(/error:_weapons.json:w1:field mod nggak dikenal: `wv`/);
  has(/error:_durations.json:default:token "X9"/);
  has(/error:HuTao.json:h1:mode "kadang"/);
  has(/error:HuTao.json:h1:hitIds "ca9"/);
  has(/error:HuTao.json:actions.E:hit "skill99"/);
  has(/error:HuTao.json:rotations\[0\]:counts hit "zzz"/);
  has(/warn:HuTao.json:rotations\[0\]:preset counts tanpa `duration`/);
  has(/error:HuTao.json:rotations\[1\]:.*Z9/);
  has(/error:HuTao.json:durations.QQ/);
  has(/error:rusak.json:-:JSON rusak/);
  await fs.rm(dir, { recursive: true, force: true });
});

test("module:new — scaffold Xiangling: entry A1/A4/C1-C6 manual, rotasi dari KQM, lolos check:buffs; nolak nimpa", async () => {
  const { createModuleFile } = await import("./moduleScaffold.service");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scaffold-"));
  const r = await createModuleFile("xiangling", { dir });
  assert.equal(r.key, "Xiangling");
  assert.equal(r.module.self.length, 8);
  assert.ok(r.module.self.every((e) => e.mode === "manual"));
  assert.equal(r.module.self.find((e) => e.id === "xiangling_c6")?.requireCon, 6);
  assert.ok(r.module.rotations?.[0]);
  assert.ok(r.module._hits.some((h) => h.startsWith("burst")));
  const issues = await checkBuffs(dir);
  assert.deepEqual(issues.filter((i) => i.level === "error"), []);
  await assert.rejects(createModuleFile("xiangling", { dir }), /sudah ada/);
  await fs.rm(dir, { recursive: true, force: true });
});
