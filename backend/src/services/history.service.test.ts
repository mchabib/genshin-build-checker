import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// service baca env saat modul di-load → set dulu, baru import dinamis
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gbc-history-"));
process.env.HISTORY_DIR = dir;
process.env.HISTORY_FLUSH_MS = "10";
const { recordUid, historyStats, flushHistory, clearHistory } = await import("./history.service");

test("recordUid: UID baru dicatat, UID lama nambah count & lastSeen; nickname ke-update", async () => {
  await recordUid("815634265", "Mr.Stars", 60);
  await recordUid("815634265", "Mr.Stars", 60);
  await recordUid("817613918", null, 59);
  // nickname awalnya kosong, terisi di pengecekan berikutnya
  await recordUid("817613918", "Shier", 60);

  const s = await historyStats({ sort: "count" });
  assert.equal(s.totalUids, 2);
  assert.equal(s.totalLookups, 4);
  assert.equal(s.uidsLast24h, 2);
  assert.equal(s.entries[0].uid, "815634265");
  assert.equal(s.entries[0].count, 2);
  const shier = s.entries.find((e) => e.uid === "817613918")!;
  assert.equal(shier.nickname, "Shier");
  assert.equal(shier.level, 60);
  assert.ok(shier.firstSeen <= shier.lastSeen);
});

test("recordUid: UID ngawur diabaikan", async () => {
  const before = (await historyStats()).totalUids;
  await recordUid("123", null, null);
  await recordUid("bukan-uid", null, null);
  await recordUid("", null, null);
  assert.equal((await historyStats()).totalUids, before);
});

test("flushHistory: nulis file JSON yang bisa dibaca balik", async () => {
  await flushHistory();
  const raw = JSON.parse(await fs.readFile(path.join(dir, "uid-history.json"), "utf8"));
  assert.ok(Array.isArray(raw));
  assert.equal(raw.length, 2);
  assert.ok(raw.every((e: { uid: string; count: number }) => e.uid && e.count > 0));
  const s = await historyStats();
  assert.ok(s.savedAt, "savedAt keisi setelah flush");
});

test("historyStats: urut lastSeen (default) vs count, limit dihormati", async () => {
  await recordUid("817613918", "Shier", 60); // paling baru
  const byTime = await historyStats();
  assert.equal(byTime.entries[0].uid, "817613918");
  const byCount = await historyStats({ sort: "count", limit: 1 });
  assert.equal(byCount.entries.length, 1);
  assert.ok(byCount.entries[0].count >= 2);
});

test("clearHistory: kosongin semua", async () => {
  const n = await clearHistory();
  assert.equal(n, 2);
  const s = await historyStats();
  assert.equal(s.totalUids, 0);
  assert.equal(s.totalLookups, 0);
  await fs.rm(dir, { recursive: true, force: true });
});
