import { test } from "node:test";
import assert from "node:assert/strict";
import {
  countResets,
  nextVersion,
  prevVersion,
  parseDay,
  patchesInRange,
  planPrimogems,
  PrimogemError,
  primogemSources,
  loadPrimogemStore,
} from "./primogem.service";

const day = (s: string) => parseDay(s, "test");

test("countResets: hitung tanggal reset yang kelewat di (from, to]", () => {
  // 1 Sep → 30 Sep: reset tanggal 16 kelewat sekali, tanggal 1 nggak (batas kiri eksklusif)
  assert.equal(countResets(day("2026-09-01"), day("2026-09-30"), [1, 16]), 1);
  // sampai 1 Okt: tanggal 1 Okt ikut kehitung
  assert.equal(countResets(day("2026-09-01"), day("2026-10-01"), [1, 16]), 2);
  // dua bulan penuh = 4 reset
  assert.equal(countResets(day("2026-09-01"), day("2026-11-01"), [1, 16]), 4);
  assert.equal(countResets(day("2026-09-01"), day("2026-09-01"), [1, 16]), 0);
  assert.equal(countResets(day("2026-09-01"), day("2026-12-01"), []), 0);
});

test("versi: maju & mundur dengan rollover di .8", () => {
  assert.equal(nextVersion("7.1"), "7.2");
  assert.equal(nextVersion("7.8"), "8.0");
  assert.equal(prevVersion("7.1"), "7.0");
  assert.equal(prevVersion("7.0"), "6.8");
  assert.equal(nextVersion("aneh"), "aneh");
});

const PATCH = { cycleDays: 42, anchor: { version: "7.1", start: "2026-09-23" }, perPatch: {} };

test("patchesInRange: overlap hari + label versi, termasuk patch sebelum anchor", () => {
  // tepat 1 patch
  const satu = patchesInRange(day("2026-09-23"), day("2026-11-04"), PATCH);
  assert.deepEqual(satu.map((p) => [p.version, p.overlapDays]), [["7.1", 42]]);
  // setengah patch
  const setengah = patchesInRange(day("2026-09-23"), day("2026-10-14"), PATCH);
  assert.deepEqual(setengah.map((p) => [p.version, p.overlapDays]), [["7.1", 21]]);
  // nyebrang ke patch berikutnya
  const dua = patchesInRange(day("2026-10-14"), day("2026-11-25"), PATCH);
  assert.deepEqual(dua.map((p) => [p.version, p.overlapDays]), [["7.1", 21], ["7.2", 21]]);
  // sebelum anchor → versi mundur
  const lama = patchesInRange(day("2026-08-12"), day("2026-09-23"), PATCH);
  assert.deepEqual(lama.map((p) => [p.version, p.overlapDays]), [["7.0", 42]]);
});

test("planPrimogems: total = jumlah baris, wish = primo/160 + fate; F2P polos cuma daily", async () => {
  const r = await planPrimogems({ from: "2026-09-23", to: "2026-11-04", events: false });
  assert.equal(r.days, 42);
  assert.equal(r.patchFraction, 1);
  // cuma daily commission: 60 × 42
  assert.deepEqual(r.rows.map((x) => x.key), ["daily.commission"]);
  assert.equal(r.totalPrimogems, 60 * 42);
  assert.equal(r.wishes, Math.floor((60 * 42) / 160));
  assert.equal(r.leftover, (60 * 42) % 160);
  assert.equal(
    r.totalPrimogems,
    r.rows.reduce((a, x) => a + x.primogems, 0),
  );
});

test("planPrimogems: welkin, BP, Abyss per bintang, Theater, Stygian, event patch, one-off, saldo awal", async () => {
  await loadPrimogemStore();
  const s = primogemSources()!;
  const r = await planPrimogems({
    from: "2026-09-23",
    to: "2026-11-04",
    welkin: true,
    battlePass: "paid",
    abyssStars: 36,
    theater: "visionary",
    stygian: "hard",
    currentPrimogems: 1000,
    currentFates: 5,
  });
  const row = (k: string) => r.rows.find((x) => x.key === k);

  assert.equal(row("current")!.primogems, 1000);
  assert.equal(row("current")!.fates, 5);
  // welkin 42 hari + 2× pembelian (ceil(42/30))
  assert.equal(row("welkin")!.primogems, 90 * 42 + 300 * 2);
  // BP penuh 1 siklus
  assert.equal(row("battlePass")!.primogems, s.battlePass.tiers.paid.primogems);
  // Abyss 36 bintang = maks, reset 1 & 16 → 16 Okt, 1 Nov, 1 Okt = 3 reset
  assert.equal(row("cycle.abyss")!.primogems, 600 * 3);
  // Theater & Stygian bulanan → 1 Okt, 1 Nov = 2 reset
  assert.equal(row("cycle.theater")!.primogems, 420 * 2);
  assert.equal(row("cycle.stygian")!.primogems, 450 * 2);
  // per patch: kode livestream + kompensasi, penuh 1 patch
  assert.equal(row("patch.codes")!.primogems, 300);
  // income event sengaja nggak dihitung sama sekali
  assert.ok(!r.rows.some((x) => x.key.startsWith("event.") || x.key.includes("eventsEstimate")));
  assert.equal(
    r.totalPrimogems,
    r.rows.reduce((a, x) => a + x.primogems, 0),
  );
  assert.equal(r.wishes, Math.floor(r.totalPrimogems / 160) + r.totalFates);
});

test("planPrimogems: per-patch di-prorate, bukan lonjakan di batas patch", async () => {
  const separuh = await planPrimogems({ from: "2026-09-23", to: "2026-10-14" });
  const penuh = await planPrimogems({ from: "2026-09-23", to: "2026-11-04" });
  const codes = (r: Awaited<ReturnType<typeof planPrimogems>>) => r.rows.find((x) => x.key === "patch.codes")!.primogems;
  assert.equal(separuh.patchFraction, 0.5);
  assert.equal(codes(separuh), Math.round(codes(penuh) / 2));
});

test("planPrimogems: BP dihitung dari level sekarang; Stardust 5 fate/bulan", async () => {
  const base = { from: "2026-09-23", to: "2026-11-04", battlePass: "paid" };
  const dariNol = await planPrimogems({ ...base, bpLevel: 0 });
  const separuhJalan = await planPrimogems({ ...base, bpLevel: 25 });
  const bp = (r: Awaited<ReturnType<typeof planPrimogems>>) => r.rows.find((x) => x.key === "battlePass")!.primogems;
  assert.equal(bp(dariNol), 680);
  assert.equal(bp(separuhJalan), 340, "level 25/50 → tinggal separuh reward");

  const stardust = await planPrimogems({ ...base, stardust: true });
  // reset tgl 1: 1 Okt & 1 Nov = 2 × 5 fate
  assert.equal(stardust.rows.find((x) => x.key === "stardust")!.fates, 10);
});

test("planPrimogems: income event nggak pernah dihitung; tambahan manual lewat extraPrimogems", async () => {
  const r = await planPrimogems({ from: "2026-09-23", to: "2026-11-04", extraPrimogems: 1000 });
  assert.ok(!r.rows.some((x) => x.key.startsWith("event.") || x.key.includes("eventsEstimate")));
  assert.equal(r.rows.find((x) => x.key === "extra")!.primogems, 1000);
});

test("planPrimogems: tolak tanggal ngawur, target di masa lalu, rentang kepanjangan", async () => {
  await assert.rejects(planPrimogems({ to: "05-11-2026" }), (e: PrimogemError) => e.code === "bad_date");
  await assert.rejects(
    planPrimogems({ from: "2026-11-04", to: "2026-09-23" }),
    (e: PrimogemError) => e.code === "bad_date",
  );
  await assert.rejects(
    planPrimogems({ from: "2026-01-01", to: "2030-01-01" }),
    (e: PrimogemError) => e.code === "range_too_long",
  );
});

test("planPrimogems: tier nggak dikenal → warning, bukan error", async () => {
  const r = await planPrimogems({ from: "2026-09-23", to: "2026-10-23", theater: "ngasal", battlePass: "vip" });
  assert.ok(r.warnings.some((w) => w.includes("theater")));
  assert.ok(r.warnings.some((w) => w.includes("battlePass")));
  assert.ok(!r.rows.some((x) => x.key === "cycle.theater"));
});
