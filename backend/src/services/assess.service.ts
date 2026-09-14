import { loadCharacterStore } from "./characterStore";
import { loadGuideStore, type GuideParsed } from "./guideStore";
import { loadGameDataStore } from "./gameDataStore";
import { fetchEnkaProfile, isValidUid } from "./enka.service";
import { EnkaError } from "./enka.types";
import { mapShowcase, toArtifactInputs } from "./enka.mapper";
import { runCheck, CheckError } from "./check.service";
import type { ScoringResult } from "./scoring.service";
import type { BenchmarkSummary } from "./benchmark.service";
import type { NormalizedStats } from "../lib/stats";

/**
 * Rakit "assessment brief": semua konteks yang dibutuhin buat menilai 1 build
 * secara holistik — data karakter dari Enka, hasil cek deterministik, dan teks
 * guide KQM mentah. Dipakai CLI (`assess`) dan endpoint `/api/assess`.
 * Ini juga yang nanti jadi context builder buat integrasi AI.
 */
export interface AssessBrief {
  uid: string;
  fetchedAt: string;
  cached: boolean;
  player: { nickname: string | null; ar: number | null };
  character: {
    key: string;
    name: string;
    element: string | null;
    weaponType: string | null;
    level: number | null;
    constellation: number;
    talents: { normal: number; skill: number; burst: number } | null;
  };
  weapon: {
    name: string | null;
    level: number;
    refinement: number;
    secondaryStat: string | null;
  } | null;
  stats: NormalizedStats;
  finalStats: { hp: number; atk: number; def: number };
  artifacts: {
    slot: string;
    setName: string | null;
    level: number;
    rarity: number;
    mainStat: { stat: string; value: number };
    substats: { stat: string; value: number }[];
  }[];
  activeSets: { name: string; count: number }[];
  deterministic: ScoringResult;
  /** benchmark damage vs build acuan artifact standar (null kalau gagal / nggak ada modul) */
  benchmark: BenchmarkSummary | null;
  guide: {
    source: string;
    sourceUrl: string;
    guideUpdated: string | null;
    parsed: GuideParsed;
    raw: Record<string, string>;
  };
  /** karakter lain di showcase — dipakai buat nebak komposisi tim */
  teammates: string[];
}

export interface AssessOptions {
  erLabel?: string;
  buildIndex?: number;
}

export async function buildAssessBrief(
  rawUid: string,
  characterQuery: string,
  opts: AssessOptions = {},
): Promise<AssessBrief> {
  const uid = rawUid.trim();
  if (!isValidUid(uid))
    throw new EnkaError("INVALID_UID", `UID tidak valid: "${uid}"`, 400);

  await Promise.all([loadCharacterStore(), loadGuideStore(), loadGameDataStore()]);

  const profile = await fetchEnkaProfile(uid);
  const showcase = mapShowcase(profile.data);

  const wantKey = characterQuery.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  const sc = showcase.find(
    (c) =>
      (c.key ?? "").toLowerCase() === wantKey ||
      c.name.replace(/[^A-Za-z0-9]/g, "").toLowerCase() === wantKey,
  );
  if (!sc || !sc.key)
    throw new CheckError(
      "not_in_showcase",
      `"${characterQuery}" nggak ada di showcase UID ${uid}. Pin dulu di Character Showcase in-game.`,
    );

  const check = await runCheck({
    source: "enka",
    characterKey: sc.key,
    stats: sc.stats,
    artifacts: toArtifactInputs(sc),
    activeSets: sc.sets,
    weapon: sc.weapon,
    constellation: sc.constellation,
    erLabel: opts.erLabel,
    buildIndex: opts.buildIndex,
    uid,
  });

  return {
    uid,
    fetchedAt: profile.fetchedAt.toISOString(),
    cached: profile.cached,
    player: {
      nickname: profile.data.playerInfo?.nickname ?? null,
      ar: profile.data.playerInfo?.level ?? null,
    },
    character: {
      key: sc.key,
      name: sc.name,
      element: sc.element,
      weaponType: sc.weaponType,
      level: sc.level,
      constellation: sc.constellation,
      talents: sc.talents,
    },
    weapon: sc.weapon,
    stats: sc.stats,
    finalStats: sc.finalStats,
    artifacts: sc.artifacts.map((a) => ({
      slot: a.slot,
      setName: a.setName,
      level: a.level,
      rarity: a.rarity,
      mainStat: a.mainStat,
      substats: a.substats,
    })),
    activeSets: sc.sets,
    deterministic: check.result,
    benchmark: check.benchmark,
    guide: check.guide,
    teammates: showcase.filter((c) => c.key !== sc.key).map((c) => c.name),
  };
}

/** Render brief jadi teks buat CLI / buat dilempar ke AI sebagai prompt context. */
export function formatAssessBrief(b: AssessBrief): string {
  const L: string[] = [];
  L.push(`=== ASSESSMENT BRIEF: ${b.character.name} ===`);
  L.push(`UID ${b.uid} · Player ${b.player.nickname ?? "?"} (AR ${b.player.ar ?? "?"})`);
  L.push("");
  L.push("CHARACTER");
  L.push(
    `  ${b.character.name} · ${b.character.element}/${b.character.weaponType} · Lv ${b.character.level ?? "?"} · C${b.character.constellation}`,
  );
  if (b.character.talents)
    L.push(
      `  Talent lvl (Normal/Skill/Burst): ${b.character.talents.normal} / ${b.character.talents.skill} / ${b.character.talents.burst}`,
    );
  if (b.weapon)
    L.push(
      `  Weapon: ${b.weapon.name ?? "?"} R${b.weapon.refinement} (secondary: ${b.weapon.secondaryStat ?? "?"})`,
    );
  L.push("");
  L.push("TOTAL STATS");
  L.push(
    `  CRIT Rate ${b.stats.critRate}% · CRIT DMG ${b.stats.critDmg}% · ER ${b.stats.energyRecharge}% · EM ${b.stats.elementalMastery}`,
  );
  L.push(
    `  ATK% ${b.stats.atkPercent ?? 0} · HP% ${b.stats.hpPercent ?? 0} · DEF% ${b.stats.defPercent ?? 0} · Elemental DMG ${b.stats.elementalDmgBonus ?? 0}%`,
  );
  L.push(`  Final: HP ${b.finalStats.hp} · ATK ${b.finalStats.atk} · DEF ${b.finalStats.def}`);
  L.push("");
  L.push("ARTIFACTS");
  for (const a of b.artifacts) {
    L.push(
      `  ${a.slot.padEnd(8)} ${(a.setName ?? "?").padEnd(28)} +${a.level} ${a.rarity}★  main: ${a.mainStat.stat} ${a.mainStat.value}`,
    );
    L.push(`           subs: ${a.substats.map((s) => `${s.stat} ${s.value}`).join(", ")}`);
  }
  L.push(`  Active set: ${b.activeSets.map((s) => `${s.count}pc ${s.name}`).join(" + ") || "-"}`);
  L.push("");
  L.push("RULE-BASED CHECK (deterministik, dari KQM)");
  L.push(
    `  Grade ${b.deterministic.grade} · ${b.deterministic.score}/100 · ${b.deterministic.passed ? "LOLOS" : "BELUM LOLOS"}`,
  );
  for (const c of b.deterministic.checks)
    L.push(`  [${c.status}] ${c.label}: ${c.detail.replace(/\n/g, " ")}`);
  if (b.benchmark) {
    L.push("");
    L.push(`BENCHMARK vs BUILD ACUAN (artifact standar KQMS, rotasi ${b.benchmark.rotation})`);
    L.push(`  ${Math.round(b.benchmark.ratio * 100)}% — kamu ${Math.round(b.benchmark.userTotal).toLocaleString("id-ID")} vs acuan ${Math.round(b.benchmark.referenceTotal).toLocaleString("id-ID")}`);
    for (const d of b.benchmark.deltas) L.push(`  ${d.stat.padEnd(14)} ${String(d.user).padStart(8)} vs ${String(d.reference).padStart(8)}  (${d.delta > 0 ? "+" : ""}${d.delta})`);
  }
  L.push("");

  const gp = b.guide.parsed;
  if (gp.talentPriority) L.push(`KQM talent priority: ${gp.talentPriority}`);
  if (gp.weaponsRanked?.length)
    L.push(`KQM weapon rank: ${gp.weaponsRanked.slice(0, 8).join(" > ")}`);
  L.push("");

  L.push("KQM GUIDE (teks mentah)");
  const preferred = [
    "overview",
    "talents",
    "constellations",
    "erRequirements",
    "artifactStats",
    "artifactSets",
    "weapons",
    "teams",
  ];
  const keys = [
    ...preferred.filter((k) => b.guide.raw[k]),
    ...Object.keys(b.guide.raw).filter((k) => !preferred.includes(k)),
  ];
  for (const key of keys) {
    const txt = b.guide.raw[key];
    if (!txt) continue;
    L.push(`  -- ${key} --`);
    for (const line of txt.split("\n")) L.push(`  ${line.trim()}`);
    L.push("");
  }

  L.push("SHOWCASE TEAMMATES (buat nebak tim)");
  L.push(`  ${b.teammates.join(", ") || "(cuma dia)"}`);
  L.push("");
  L.push(`guide: ${b.guide.sourceUrl}`);
  return L.join("\n");
}
