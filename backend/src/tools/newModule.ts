import { createModuleFile } from "../services/moduleScaffold.service";

/** npm run module:new -- <Key|nama> [--force] — scaffold scrape-data/Buffs/<Key>.json */
async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const query = args.filter((a) => !a.startsWith("--")).join(" ");
  if (!query) {
    console.error("pakai: npm run module:new -- <Key|nama> [--force]");
    process.exit(2);
  }
  const r = await createModuleFile(query, { force });
  console.log(`ditulis: ${r.file}`);
  console.log(`  role tebakan: ${r.module.role} · ${r.module.self.length} entry (A1/A4/C1-C6, semua mode manual) · rotasi: ${r.module.rotations?.[0]?.label}`);
  console.log(`  hit: ${r.module._hits.join(", ")}`);
  console.log("  lanjut: isi angka di `mod`, lalu `npm run check:buffs`");
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
