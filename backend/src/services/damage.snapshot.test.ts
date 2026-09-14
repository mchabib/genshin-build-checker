import { test } from "node:test";
import assert from "node:assert/strict";
import { collectSnapshot, diffSnapshot, readSnapshot, SNAPSHOT_TARGETS } from "./snapshot.service";

/**
 * Regresi angka damage offline dari fixture Enka (src/fixtures/enka). Kalau sengaja ngubah kalkulasi/data,
 * jalankan `npm run snapshot:update` lalu cek diff-nya masuk akal.
 * Butuh store Enka (characters.json/loc.json) di .cache/enka — di-fetch sekali kalau belum ada.
 */
for (const target of SNAPSHOT_TARGETS) {
  test(`snapshot damage offline UID ${target.uid} sama dengan src/fixtures/snapshots`, async () => {
    const expected = await readSnapshot(target.uid);
    assert.ok(expected, `belum ada snapshot ${target.uid} — jalankan npm run snapshot:update`);
    const actual = await collectSnapshot(target);
    const diff = diffSnapshot(expected, actual);
    assert.deepEqual(diff, [], `snapshot ${target.uid} berubah:\n  ${diff.join("\n  ")}\n(kalau memang disengaja: npm run snapshot:update)`);
  });
}
