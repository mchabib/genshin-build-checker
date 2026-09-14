/**
 * CLI Genshin Build Checker (Fase 1).
 *
 *   npm run cli -- characters [filter]
 *   npm run cli -- guide <key|nama>
 *   npm run cli -- enka <uid>
 *   npm run cli -- check <uid> <key|nama> [--er "<label>"] [--build <n>]
 *   npm run cli -- check-manual <key|nama> --cr 70 --cd 140 --er 160 --em 40 [--atk 46] [--hp 46]
 */
import {
  allResolved,
  findCharacterByQuery,
  loadCharacterStore,
} from "./services/characterStore";
import { getGuide, guideKeys, loadGuideStore } from "./services/guideStore";
import { loadGameDataStore } from "./services/gameDataStore";
import { fetchEnkaProfile, isValidUid } from "./services/enka.service";
import { EnkaError } from "./services/enka.types";
import { mapShowcase, toArtifactInputs, type ShowcaseCharacter } from "./services/enka.mapper";
import { runCheck, CheckError } from "./services/check.service";
import { buildAssessBrief, formatAssessBrief } from "./services/assess.service";
import { parseRotationParam, runDamage, DamageError, type DamageReport } from "./services/damage.run";
import { runBenchmark } from "./services/benchmark.service";
import { runTeamRotation, RotationError } from "./services/rotation.run";
import { assessWithLlm, formatAssessLlm } from "./services/assess.llm";
import { describeLlmOptions, isLlmConfigured, LlmError, parseLlmOptions } from "./services/llm.client";

/** --model / --thinking on|off / --effort low|medium|high */
function llmFlags(flags: Record<string, string>) {
  const { options, warnings } = parseLlmOptions({ model: flags.model, thinking: flags.thinking, effort: flags.effort });
  for (const w of warnings) console.error(`! ${w}`);
  return options;
}
import type { DamageTable, RotationTiming } from "./services/damage.types";
import type { ScoringResult } from "./services/scoring.service";
import type { NormalizedStats } from "./lib/stats";

const MARK: Record<string, string> = {
  pass: "✓",
  info: "ℹ",
  warn: "!",
  fail: "✗",
  skip: "·",
};

/** flag tanpa nilai (biar nggak "makan" argumen berikutnya) */
const BOOL_FLAGS = new Set(["json", "raw", "full", "no-llm", "llm", "show-prompt", "no-assume"]);

function parseFlags(args: string[]) {
  const flags: Record<string, string> = {};
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const name = args[i].slice(2);
      if (BOOL_FLAGS.has(name)) flags[name] = "1";
      else flags[name] = args[++i] ?? "";
    } else pos.push(args[i]);
  }
  return { flags, pos };
}

/** Cari karakter + guide-nya dari store statis. */
async function findCharacter(q: string) {
  await Promise.all([loadCharacterStore(), loadGuideStore(), loadGameDataStore()]);
  const c = findCharacterByQuery(q);
  if (!c) return null;
  return {
    key: c.key,
    name: c.nameEn,
    element: c.element ?? "?",
    weaponType: c.weaponType ?? "?",
    guide: getGuide(c.key),
  };
}

function printResult(r: ScoringResult) {
  console.log(
    `\n  Grade ${r.grade}  ·  skor ${r.score}/100  ·  ${r.passed ? "LOLOS" : "BELUM LOLOS"}` +
      (r.buildName ? `  ·  build: ${r.buildName}` : "") +
      (r.erLabel ? `  ·  ER: ${r.erLabel}` : ""),
  );
  for (const c of r.checks) {
    console.log(`  [${MARK[c.status] ?? "?"}] ${c.label}`);
    for (const line of c.detail.split("\n")) console.log(`      ${line}`);
  }
  if (r.recommendations.length) {
    console.log("\n  Rekomendasi:");
    for (const rec of r.recommendations) console.log(`   - ${rec}`);
  }
}

// ---------- commands ----------
async function cmdCharacters(filter?: string) {
  await Promise.all([loadCharacterStore(), loadGuideStore(), loadGameDataStore()]);
  const withGuide = guideKeys();
  const chars = allResolved()
    .filter((c) => !filter || c.nameEn.toLowerCase().includes(filter.toLowerCase()))
    .sort((a, b) => a.nameEn.localeCompare(b.nameEn));
  for (const c of chars) {
    console.log(
      `${withGuide.has(c.key) ? "●" : "○"} ${c.key.padEnd(22)} ${c.nameEn.padEnd(20)} ${c.element}/${c.weaponType}`,
    );
  }
  console.log(
    `\n${chars.filter((c) => withGuide.has(c.key)).length}/${chars.length} punya guide KQM (● = ada guide)`,
  );
}

async function cmdGuide(q: string, flags: Record<string, string>) {
  const c = await findCharacter(q);
  if (!c) return console.error(`Karakter "${q}" nggak ketemu.`);
  if (!c.guide) return console.error(`${c.name} belum ada guide KQM.`);
  const g = c.guide;
  const raw = g.raw ?? {};
  const p = g.parsed ?? {};

  console.log(`\n== ${c.name} (${c.element}/${c.weaponType}) ==`);
  console.log(`${g.sourceUrl}  ·  update ${g.guideUpdated?.slice(0, 10) ?? "?"}\n`);

  (p.builds ?? []).forEach((b, i) => {
    console.log(`Build ${i}${b.name ? ` — ${b.name}` : ""}`);
    console.log(`  Sands  : ${b.sands.join(" / ") || "-"}`);
    console.log(`  Goblet : ${b.goblet.join(" / ") || "-"}`);
    console.log(`  Circlet: ${b.circlet.join(" / ") || "-"}`);
    console.log(`  Substat: ${b.substatPriority.join(" > ") || "-"}`);
  });

  if (p.talentPriority) console.log(`\nTalent priority: ${p.talentPriority}`);

  if (p.erRequirements?.length) {
    console.log("\nER requirement:");
    for (const e of p.erRequirements)
      console.log(`  ${e.label}: ${e.min}${e.max ? `–${e.max}%` : "%+"}`);
  } else if (raw.erRequirements) {
    console.log(`\nER requirement (mentah):\n  ${raw.erRequirements.replace(/\n/g, "\n  ")}`);
  }

  if (p.sets?.length) {
    console.log("\nSet:");
    for (const s of p.sets) console.log(`  ${s.pieces}pc ${s.name}`);
  }
  if (p.weaponsRanked?.length) {
    console.log("\nSenjata (rank KQM):");
    p.weaponsRanked.forEach((w, i) => console.log(`  ${i + 1}. ${w}`));
  }
  if (p.constellations && Object.keys(p.constellations).length) {
    console.log("\nConstellation:");
    for (const [n, d] of Object.entries(p.constellations))
      console.log(`  C${n}: ${d.slice(0, 150)}${d.length > 150 ? "…" : ""}`);
  }

  if (flags.raw || flags.full) {
    console.log("\n--- TEKS MENTAH ---");
    for (const [k, v] of Object.entries(raw)) {
      console.log(`\n[${k}]\n${v}`);
    }
  } else {
    console.log(`\n(pakai --raw buat teks guide lengkap: ${Object.keys(raw).join(", ")})`);
  }
}

function fmtStats(s: NormalizedStats) {
  return `CR ${s.critRate}% · CD ${s.critDmg}% · ER ${s.energyRecharge}% · EM ${s.elementalMastery}` +
    (s.hpPercent ? ` · HP% ${s.hpPercent}` : "") +
    (s.atkPercent ? ` · ATK% ${s.atkPercent}` : "");
}

async function cmdEnka(uid: string) {
  if (!isValidUid(uid)) return console.error(`UID "${uid}" nggak valid.`);
  await Promise.all([loadCharacterStore(), loadGuideStore(), loadGameDataStore()]);
  let res;
  try {
    res = await fetchEnkaProfile(uid);
  } catch (e) {
    if (e instanceof EnkaError) return console.error(`Enka: ${e.message}`);
    throw e;
  }
  const chars = mapShowcase(res.data);
  console.log(
    `\n${res.data.playerInfo?.nickname ?? "?"} · AR ${res.data.playerInfo?.level ?? "?"} · ${
      res.cached ? "cache" : "fresh"
    } · ${chars.length} karakter\n`,
  );

  const withGuide = guideKeys();

  for (const c of chars) {
    const setStr = c.sets.map((s) => `${s.count}pc ${s.name}`).join(", ") || "-";
    const w = c.weapon
      ? `${c.weapon.name ?? "?"} R${c.weapon.refinement}`
      : "?";
    const t = c.talents ? ` · talent ${c.talents.normal}/${c.talents.skill}/${c.talents.burst}` : "";
    console.log(`● ${c.name} (Lv ${c.level ?? "?"} · C${c.constellation}${t})`);
    console.log(`  ${w}  |  ${setStr}`);
    console.log(`  ${fmtStats(c.stats)}`);
    if (c.key && withGuide.has(c.key)) {
      await checkShowcase(c, uid);
    } else {
      console.log("  (belum ada guide KQM)\n");
    }
  }
}

async function checkShowcase(c: ShowcaseCharacter, uid: string, erLabel?: string, buildIndex?: number) {
  try {
    const out = await runCheck({
      source: "enka",
      characterKey: c.key!,
      stats: c.stats,
      artifacts: toArtifactInputs(c),
      activeSets: c.sets,
      weapon: c.weapon,
      constellation: c.constellation,
      erLabel,
      buildIndex,
      uid,
    });
    printResult(out.result);
    console.log(`  guide: ${out.guide.sourceUrl}\n`);
  } catch (e) {
    if (e instanceof CheckError) console.log(`  ${e.message}\n`);
    else throw e;
  }
}

async function cmdCheck(uid: string, q: string, flags: Record<string, string>) {
  if (!isValidUid(uid)) return console.error(`UID "${uid}" nggak valid.`);
  const ch = await findCharacter(q);
  if (!ch) return console.error(`Karakter "${q}" nggak ketemu.`);
  await loadCharacterStore();
  const res = await fetchEnkaProfile(uid).catch((e) => {
    if (e instanceof EnkaError) {
      console.error(`Enka: ${e.message}`);
      return null;
    }
    throw e;
  });
  if (!res) return;
  const sc = mapShowcase(res.data).find((c) => c.key === ch.key);
  if (!sc)
    return console.error(
      `${ch.name} nggak ada di showcase UID ${uid}. Pin dulu di Character Showcase in-game.`,
    );
  const w = sc.weapon ? `${sc.weapon.name ?? "?"} R${sc.weapon.refinement}` : "?";
  console.log(
    `\n${sc.name} · Lv ${sc.level ?? "?"} · C${sc.constellation}` +
      (sc.talents ? ` · talent ${sc.talents.normal}/${sc.talents.skill}/${sc.talents.burst}` : ""),
  );
  console.log(`${w}  |  ${sc.sets.map((s) => `${s.count}pc ${s.name}`).join(", ") || "-"}`);
  console.log(fmtStats(sc.stats));
  await checkShowcase(sc, uid, flags.er, flags.build ? Number(flags.build) : undefined);
}

async function cmdAssess(uid: string, q: string, flags: Record<string, string>) {
  try {
    const brief = await buildAssessBrief(uid, q, {
      erLabel: flags.er,
      buildIndex: flags.build ? Number(flags.build) : undefined,
    });
    if (flags.llm) {
      if (!isLlmConfigured()) return console.error("LLM_API_KEY belum diisi di backend/.env");
      const lo = llmFlags(flags);
      console.error(`[llm] ${describeLlmOptions(lo)} …`);
      const r = await assessWithLlm(brief, lo);
      console.log(flags.json ? JSON.stringify({ brief, llm: r }, null, 2) : formatAssessLlm(r));
      return;
    }
    console.log(flags.json ? JSON.stringify(brief, null, 2) : formatAssessBrief(brief));
  } catch (e) {
    if (e instanceof EnkaError) return console.error(`Enka: ${e.message}`);
    if (e instanceof CheckError) return console.error(e.message);
    if (e instanceof LlmError) return console.error(`LLM: ${e.message}`);
    throw e;
  }
}

const fmtN = (n: number) => Math.round(n).toLocaleString("en-US");

function printDamageTable(title: string, t: DamageTable) {
  console.log(`\n  ${title}`);
  console.log(
    `  ATK ${fmtN(t.stats.atk)} · HP ${fmtN(t.stats.hp)} · DEF ${fmtN(t.stats.def)} · EM ${fmtN(t.stats.em)} · CR ${t.stats.critRate.toFixed(1)}% · CD ${t.stats.critDmg.toFixed(1)}%`,
  );
  const W = 34;
  const head = `  ${"id".padEnd(18)} ${"hit".padEnd(W)} ${"elemen/reaksi".padEnd(18)} ${"non-crit".padStart(9)} ${"crit".padStart(9)} ${"avg".padStart(9)}`;
  console.log(head);
  console.log("  " + "-".repeat(head.length - 2));
  for (const h of t.hits) {
    const er = h.element + (h.reaction ? ` +${h.reaction}` : "");
    const label = (h.hitCount > 1 ? `×${h.hitCount} ${h.label}` : h.label).slice(0, W);
    console.log(
      `  ${h.id.padEnd(18)} ${label.padEnd(W)} ${er.padEnd(18)} ${fmtN(h.nonCrit).padStart(9)} ${fmtN(h.crit).padStart(9)} ${fmtN(h.avg).padStart(9)}`,
    );
  }
  for (const tr of t.transformative)
    console.log(`  ${("react:" + tr.reaction).padEnd(18)} ${"(transformative, per proc)".padEnd(W)} ${tr.element.padEnd(18)} ${"".padStart(9)} ${"".padStart(9)} ${fmtN(tr.dmg).padStart(9)}`);
}

/** " · 12.4s · DPS 35,120 (dari notasi)" atau "" kalau durasi nggak diketahui */
function fmtTiming(t: RotationTiming | undefined): string {
  if (!t?.duration) return "";
  const src = t.source === "notation" ? "dari notasi" : t.source === "module" ? "durasi modul" : "--duration";
  return ` · ${t.duration}s · DPS ${fmtN(t.dps ?? 0)} (${src})`;
}

function printDamageReport(r: DamageReport) {
  const c = r.character;
  console.log(
    `\n${c.name} · Lv ${c.level} · C${c.constellation} · talent ${c.talentLevels.normal}/${c.talentLevels.skill}/${c.talentLevels.burst}` +
      (c.weapon ? ` · ${c.weapon.name} R${c.weapon.refinement}` : ""),
  );
  console.log(
    `${c.sets.map((s) => `${s.count}pc ${s.name}`).join(", ") || "-"} · NA/CA/plunge: ${c.naElements.na}/${c.naElements.ca}/${c.naElements.plunge}` +
      (c.role ? ` · role ${c.role}` : "") +
      (c.hasModule ? "" : " · (belum ada modul Buffs)"),
  );
  console.log(
    `Mode ${r.mode.toUpperCase()} · musuh Lv ${r.enemy.level}, RES ${Math.round(r.enemy.res.pyro * 100)}%` +
      (r.team.members.length ? ` · tim: ${r.team.members.map((m) => m.name).join(", ")} (${r.team.reason})` : " · solo" + (r.team.reason ? ` (${r.team.reason})` : "")),
  );
  const reacts = Object.entries(r.reactions).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(", ");
  if (reacts || r.reactionReason) console.log(`Reaksi: ${reacts || "-"}${r.reactionReason ? ` (${r.reactionReason})` : ""}`);

  printDamageTable("BASELINE (self-buff pasti aktif)", r.baseline);
  const extra = r.modifiers.filter((m) => m.origin !== "self");
  if (extra.length) printDamageTable("DENGAN BUFF TIM / ASUMSI KONDISIONAL", r.buffed);

  if (r.modifiers.length) {
    console.log("\n  Modifier aktif:");
    for (const m of r.modifiers) {
      const { origin, source, note, scope, hitIds, id: _id, ...vals } = m;
      const v = Object.entries(vals)
        .filter(([, x]) => x != null)
        .map(([k, x]) => `${k}=${typeof x === "object" ? JSON.stringify(x) : x}`)
        .join(" ");
      console.log(`   [${origin}] ${source} (${hitIds?.join("/") ?? (Array.isArray(scope) ? scope.join("/") : scope)}): ${v}${note ? ` — ${note}` : ""}`);
    }
  }
  if (r.rotation) {
    console.log(`\n  Rotasi (${r.rotation.source}): ${r.rotation.label}${r.rotation.note ? ` — ${r.rotation.note}` : ""}`);
    for (const row of r.rotation.rows) console.log(`   ${row.count}× ${row.label.padEnd(30)} ${fmtN(row.avg).padStart(9)} = ${fmtN(row.subtotal).padStart(10)}`);
    console.log(`   TOTAL ${fmtN(r.rotation.total)}${fmtTiming(r.rotation.timing)}`);
  }
  if (r.llm) {
    if (r.llm.used) {
      const rt = r.llm.usage?.completion_tokens_details?.reasoning_tokens;
      console.log(
        `\n  LLM (${r.llm.model}${r.llm.cached ? ", cache" : ""}${r.llm.usage?.total_tokens ? `, ${r.llm.usage.total_tokens} token${rt ? `, ${rt} reasoning` : ""}` : ""}):`,
      );
      if (r.team.source === "llm") console.log(`   Tim dipilih LLM: ${r.team.members.map((m) => m.name).join(", ")} — ${r.llm.teamReason}`);
      for (const n of r.llm.notes) console.log(`   · ${n}`);
      if (r.llm.verdict) console.log(`   Verdict: ${r.llm.verdict}`);
      for (const w of r.llm.warnings) console.log(`   ! ${w}`);
    } else console.log(`\n  LLM nggak dipakai: ${r.llm.error}`);
  }
  if (r.warnings.length) {
    console.log("\n  Catatan:");
    for (const w of r.warnings) console.log(`   - ${w}`);
  }
}

async function cmdDamage(uid: string, q: string, flags: Record<string, string>) {
  try {
    const report = await runDamage(uid, q, {
      team: flags.team?.split(","),
      reaction: flags.reaction,
      enemyLevel: flags["enemy-lvl"] ? Number(flags["enemy-lvl"]) : undefined,
      enemyResPct: flags["enemy-res"] ? Number(flags["enemy-res"]) : undefined,
      catalogIds: flags.catalog?.split(","),
      llm: Boolean(flags.llm) && !flags["no-llm"] && !flags["show-prompt"],
      llmOptions: llmFlags(flags),
      noAssume: Boolean(flags["no-assume"]),
      dumpPrompt: Boolean(flags["show-prompt"]),
      duration: flags.duration ? Number(flags.duration) : undefined,
      stellarHits: flags["stellar-hits"] ? Number(flags["stellar-hits"]) : undefined,
      // --rotation "na1=9,ca1=9" (hit id) ATAU notasi KQM "E 9[N1C] Q"
      rotation: parseRotationParam(flags.rotation),
    });
    if (flags["show-prompt"] && report.context.prompt) {
      console.log("=== SYSTEM ===\n" + report.context.prompt.system + "\n\n=== USER ===\n" + report.context.prompt.user);
      return;
    }
    if (flags.json) {
      const { context: _ctx, ...pub } = report;
      console.log(JSON.stringify(pub, null, 2));
    } else printDamageReport(report);
  } catch (e) {
    if (e instanceof EnkaError) return console.error(`Enka: ${e.message}`);
    if (e instanceof CheckError || e instanceof DamageError) return console.error(e.message);
    throw e;
  }
}

async function cmdRotation(uid: string, notation: string, flags: Record<string, string>) {
  if (!notation.trim()) return console.error('Notasi kosong. Contoh: rotation <uid> "Yae 3[E] > Odette 2[E] > Qiqi E Q > Sandrone 3[C E] Q"');
  try {
    const r = await runTeamRotation(uid, notation, {
      enemyLevel: flags["enemy-lvl"] ? Number(flags["enemy-lvl"]) : undefined,
      enemyResPct: flags["enemy-res"] ? Number(flags["enemy-res"]) : undefined,
      noAssume: Boolean(flags["no-assume"]),
      catalogIds: flags.catalog?.split(","),
      reaction: flags.reaction,
      stellarHits: flags["stellar-hits"] ? Number(flags["stellar-hits"]) : undefined,
      duration: flags.duration ? Number(flags.duration) : undefined,
    });
    if (flags.json) return console.log(JSON.stringify(r, null, 2));
    console.log(`\nRotasi tim: ${r.notation}`);
    console.log(`Musuh Lv ${r.characters[0]?.report.enemy.level ?? 90} · ${r.characters.length} karakter\n`);
    for (const c of r.characters) {
      const rep = c.report;
      console.log(`● ${c.name} — ${c.notation}${c.duration != null ? ` (${c.duration}s)` : ""}`);
      const reacts = Object.entries(rep.reactions).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(", ");
      console.log(`  tim: ${rep.team.members.map((m) => m.name).join(", ") || "-"}${reacts ? ` · reaksi: ${reacts}` : ""}`);
      const team = rep.modifiers.filter((m) => m.origin === "team" || m.origin === "assume" || m.origin === "catalog");
      if (team.length) console.log(`  buff: ${team.map((m) => `${m.source}${m.origin === "assume" ? "*" : ""}`).join(", ")}`);
      for (const row of rep.rotation?.rows ?? [])
        console.log(`   ${String(row.count).padStart(3)}× ${row.label.padEnd(34).slice(0, 34)} ${fmtN(row.avg).padStart(9)} = ${fmtN(row.subtotal).padStart(10)}`);
      console.log(`  subtotal ${fmtN(c.subtotal)}\n`);
    }
    if (r.lunar) {
      console.log(`● Reaksi Lunar-Charged (tim) — ${r.lunar.ticks} tick × ${fmtN(r.lunar.perTick)} = ${fmtN(r.lunar.total)}`);
      console.log(`  kontributor: ${r.lunar.contributors.map((c) => `${c.name} ${fmtN(c.dmg)}×${c.weight === 1 ? "1" : c.weight === 0.5 ? "½" : "1/12"}`).join(" · ")}\n`);
    }
    console.log(`TOTAL TIM per rotasi: ${fmtN(r.total)}${r.duration != null ? ` · ${r.duration}s · DPS tim ${fmtN(r.dps ?? 0)}` : " · durasi nggak diketahui"}`);
    console.log(
      r.characters.map((c) => `${c.name} ${r.total ? Math.round((c.subtotal / r.total) * 100) : 0}%`).join(" · "),
    );
    if (r.warnings.length) {
      console.log("\nCatatan:");
      for (const w of r.warnings) console.log(` - ${w}`);
    }
    console.log("\n(* = asumsi kondisional; nonaktifkan dengan --no-assume)");
  } catch (e) {
    if (e instanceof EnkaError) return console.error(`Enka: ${e.message}`);
    if (e instanceof CheckError || e instanceof DamageError || e instanceof RotationError) return console.error(e.message);
    throw e;
  }
}

async function cmdCheckManual(q: string, flags: Record<string, string>) {
  const ch = await findCharacter(q);
  if (!ch) return console.error(`Karakter "${q}" nggak ketemu.`);
  const n = (k: string, d?: number) => (flags[k] != null ? Number(flags[k]) : d);
  const stats: NormalizedStats = {
    critRate: n("cr", 5)!,
    critDmg: n("cd", 50)!,
    energyRecharge: n("er", 100)!,
    elementalMastery: n("em", 0)!,
    atkPercent: n("atk"),
    hpPercent: n("hp"),
    defPercent: n("def"),
  };
  try {
    const out = await runCheck({
      source: "manual",
      characterKey: ch.key,
      stats,
      weapon: flags.weapon
        ? {
            name: flags.weapon,
            refinement: flags.refine ? Number(flags.refine) : 1,
            secondaryStat: flags["weapon-stat"] ?? null,
          }
        : null,
      constellation: flags.con != null ? Number(flags.con) : undefined,
      erLabel: flags.er ?? flags["er-label"],
      buildIndex: flags.build ? Number(flags.build) : undefined,
    });
    console.log(`\n${out.character.name} · ${fmtStats(stats)}`);
    printResult(out.result);
    console.log(`\nguide: ${out.guide.sourceUrl}`);
  } catch (e) {
    if (e instanceof CheckError) console.error(e.message);
    else throw e;
  }
}

async function cmdBenchmark(uid: string, q: string, flags: Record<string, string>) {
  try {
    const r = await runBenchmark(uid, q, {
      team: flags.team?.split(","),
      reaction: flags.reaction,
      enemyLevel: flags["enemy-lvl"] ? Number(flags["enemy-lvl"]) : undefined,
      enemyResPct: flags["enemy-res"] ? Number(flags["enemy-res"]) : undefined,
      catalogIds: flags.catalog?.split(","),
      rotation: parseRotationParam(flags.rotation),
      duration: flags.duration ? Number(flags.duration) : undefined,
      noAssume: Boolean(flags["no-assume"]),
      stellarHits: flags["stellar-hits"] ? Number(flags["stellar-hits"]) : undefined,
      buildIndex: flags.build ? Number(flags.build) : undefined,
      erLabel: flags.er,
      erTarget: flags["er-target"] ? Number(flags["er-target"]) : undefined,
    });
    if (flags.json) return console.log(JSON.stringify(r, null, 2));
    const c = r.character;
    console.log(`\n${c.name} · Lv ${c.level} · C${c.constellation}${c.weapon ? ` · ${c.weapon.name} R${c.weapon.refinement}` : ""} · ${c.sets.map((s) => `${s.count}pc ${s.name}`).join(", ") || "-"}`);
    console.log(`Build acuan: ${r.build.name ?? "(default)"}${r.build.source === "kqm" ? " (KQM)" : ""} · rotasi ${r.rotation.label}${r.rotation.duration ? ` (${r.rotation.duration}s)` : ""}`);
    console.log(`Tim: ${r.team.members.map((m) => m.name).join(", ") || "solo"}${r.team.reason ? ` (${r.team.reason})` : ""}`);
    const icon = r.status === "pass" ? "🟢" : r.status === "warn" ? "🟡" : "🔴";
    console.log(`\n${icon} ${r.verdict}`);
    console.log(`   kamu ${fmtN(r.user.total)}${r.user.dps ? ` (DPS ${fmtN(r.user.dps)})` : ""} vs acuan ${fmtN(r.reference.total)}${r.reference.dps ? ` (DPS ${fmtN(r.reference.dps)})` : ""} = ${Math.round(r.ratio * 100)}%`);
    console.log("\n  Stat                kamu       acuan      selisih");
    for (const d of r.deltas) {
      const f = (n: number) => (Number.isInteger(n) ? fmtN(n) : n.toFixed(1));
      const sign = d.delta > 0 ? "+" : "";
      console.log(`  ${d.stat.padEnd(16)} ${f(d.user).padStart(9)} ${f(d.reference).padStart(9)}   ${(sign + f(d.delta)).padStart(8)}`);
    }
    const m = r.reference.mains;
    console.log(`\n  Artifact acuan: ${m.sands} / ${m.goblet} / ${m.circlet}${r.reference.erTarget != null ? ` · target ER ${r.reference.erTarget}% (${r.reference.erSource})` : ""}`);
    const subs = Object.entries(r.reference.substats)
      .filter(([, s]) => s.fixed + s.liquid > 0)
      .map(([t, s]) => `${t} ${s.fixed}+${s.liquid} roll = ${s.value}`)
      .join(" · ");
    console.log(`  Substat acuan: ${subs}`);
    if (r.warnings.length) {
      console.log("\n  Catatan:");
      for (const w of r.warnings) console.log(`   - ${w}`);
    }
  } catch (e) {
    if (e instanceof EnkaError) return console.error(`Enka: ${e.message}`);
    if (e instanceof CheckError || e instanceof DamageError) return console.error(e.message);
    throw e;
  }
}

// ---------- main ----------
async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, pos } = parseFlags(rest);

  switch (cmd) {
    case "characters":
      await cmdCharacters(pos[0]);
      break;
    case "guide":
      await cmdGuide(pos.join(" "), flags);
      break;
    case "enka":
      await cmdEnka(pos[0]);
      break;
    case "check":
      await cmdCheck(pos[0], pos.slice(1).join(" "), flags);
      break;
    case "assess":
      await cmdAssess(pos[0], pos.slice(1).join(" "), flags);
      break;
    case "check-manual":
      await cmdCheckManual(pos.join(" "), flags);
      break;
    case "damage":
      await cmdDamage(pos[0], pos.slice(1).join(" "), flags);
      break;
    case "rotation":
      await cmdRotation(pos[0], pos.slice(1).join(" "), flags);
      break;
    case "benchmark":
      await cmdBenchmark(pos[0], pos.slice(1).join(" "), flags);
      break;
    default:
      console.log(
        [
          "Perintah:",
          "  characters [filter]              daftar karakter (● = ada guide)",
          "  guide <key|nama>                 tampilkan guide KQM",
          "  enka <uid>                       fetch showcase + auto-cek semua",
          '  check <uid> <key|nama> [--er "label"] [--build n]',
          "  check-manual <key|nama> --cr 70 --cd 140 --er 160 --em 40 [--atk] [--hp]",
          "  assess <uid> <key|nama> [--json] [--llm]  dump konteks 1 karakter; --llm = verdict dari LLM",
          "  damage <uid> <key|nama> [--team a,b,c] [--reaction vaporize | ca=vaporize,na=none] [--no-assume]",
          "         [--enemy-lvl 90] [--enemy-res 10] [--catalog vv_4pc,cw_4pc] [--rotation na1=3,ca1=2,burst1=1] [--json]",
          "         default OFFLINE (rule + scrape-data/Buffs). --llm = pakai LLM buat tim/buff/reaksi/rotasi. --show-prompt = lihat prompt.",
          '         --rotation juga terima notasi KQM: --rotation "E 9[N1C] Q"  · --duration <detik> buat rotasi counts (DPS + uptime buff)',
          "         --stellar-hits <0-12> hit Cryo/Electro terekam Polestar Field per 4s (koefisien Stellar-Conduct, default 8 = ×1.8)",
          '  rotation <uid> "Yae 3[E] > Odette 2[E] > Qiqi E Q > Sandrone 3[C E] Q"   rotasi TIM: tiap karakter dihitung, buff support',
          "         cuma aktif kalau E/Q-nya ada di urutan. [--enemy-lvl] [--enemy-res] [--no-assume] [--json]",
          "  benchmark <uid> <key|nama> [--build n] [--er label | --er-target 160] [--team] [--rotation] [--json]",
          "         build kamu vs build acuan (artifact standar KQMS, sisanya sama) → % dari standar + stat yang ketinggalan",
          "  Opsi LLM (assess --llm & damage): --model deepseek-v4-pro|deepseek-flash  --thinking on|off  --effort low|medium|high",
          `         default dari .env: ${describeLlmOptions()}`,
        ].join("\n"),
      );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
