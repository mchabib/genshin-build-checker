import { collectSnapshot, diffSnapshot, readSnapshot, SNAPSHOT_TARGETS, writeSnapshot } from "../services/snapshot.service";

/**
 * npm run snapshot:update  → tulis ulang src/fixtures/snapshots/<uid>.json (nampilin diff vs yang lama)
 * npm run snapshot:check   → cuma bandingin, exit 1 kalau beda (sama kayak test, tapi outputnya lebih rinci)
 */
async function main() {
  const check = process.argv.includes("--check");
  let failed = false;
  for (const target of SNAPSHOT_TARGETS) {
    const actual = await collectSnapshot(target);
    const expected = await readSnapshot(target.uid);
    const diff = expected ? diffSnapshot(expected, actual) : ["belum ada snapshot"];
    console.log(`UID ${target.uid}: ${Object.keys(actual.characters).length} karakter${actual.teamRotation ? " + rotasi tim" : ""}`);
    if (!diff.length) console.log("  sama dengan snapshot");
    else for (const d of diff) console.log(`  - ${d}`);
    if (check) {
      if (diff.length) failed = true;
    } else {
      const file = await writeSnapshot(actual);
      console.log(`  ditulis: ${file}`);
    }
  }
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
