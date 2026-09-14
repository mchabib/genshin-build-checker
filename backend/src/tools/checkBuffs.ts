import { checkBuffs } from "../services/buffCheck.service";

/** npm run check:buffs — validasi scrape-data/Buffs; exit 1 kalau ada error (warning nggak). */
async function main() {
  const issues = await checkBuffs();
  const errors = issues.filter((i) => i.level === "error");
  const warns = issues.filter((i) => i.level === "warn");
  for (const i of issues) console.log(`${i.level === "error" ? "✗" : "!"} ${i.file} › ${i.where}: ${i.message}`);
  console.log(`\n${errors.length} error, ${warns.length} warning`);
  if (errors.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
