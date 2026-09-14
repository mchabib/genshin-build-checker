import type { NormalizedStats } from "../lib/stats";
import { resolveByKey } from "./characterStore";
import { getGuide, loadGuideStore, type GuideParsed } from "./guideStore";
import { getCharacterModule, loadBuffStore } from "./buffStore";
import type { BenchmarkSummary } from "./benchmark.service";
import {
  scoreBuild,
  type ArtifactInput,
  type GuideInput,
  type ScoringResult,
  type WeaponInput,
} from "./scoring.service";

export interface RunCheckInput {
  source: "enka" | "manual";
  characterKey: string;
  stats: NormalizedStats;
  artifacts?: ArtifactInput[];
  activeSets?: { name: string; count: number }[];
  weapon?: WeaponInput | null;
  constellation?: number;
  buildIndex?: number;
  erLabel?: string;
  uid?: string;
  /** jalankan benchmark damage vs build acuan (butuh source enka + uid). default: true */
  benchmark?: boolean;
}

export interface RunCheckResult {
  character: { key: string; name: string; element: string | null };
  guide: {
    source: string;
    sourceUrl: string;
    guideUpdated: string | null;
    parsed: GuideParsed;
    raw: Record<string, string>;
  };
  result: ScoringResult;
  /** ringkasan benchmark (null kalau nggak dijalankan / gagal) */
  benchmark: BenchmarkSummary | null;
}

export class CheckError extends Error {
  constructor(
    public code: "character_not_found" | "no_guide" | "not_in_showcase",
    message: string,
  ) {
    super(message);
  }
}

export async function runCheck(input: RunCheckInput): Promise<RunCheckResult> {
  await Promise.all([loadGuideStore(), loadBuffStore()]);

  const character = resolveByKey(input.characterKey);
  if (!character)
    throw new CheckError(
      "character_not_found",
      `Karakter "${input.characterKey}" nggak ada.`,
    );

  const g = getGuide(character.key);
  if (!g)
    throw new CheckError("no_guide", `Belum ada guide KQM buat ${character.nameEn}.`);

  const raw = g.raw ?? {};
  const parsed = g.parsed ?? {};

  const guide: GuideInput = {
    builds: parsed.builds ?? [],
    erRequirements: parsed.erRequirements ?? [],
    sets: parsed.sets ?? [],
    weaponsRanked: parsed.weaponsRanked ?? [],
    rawErRequirements: raw.erRequirements ?? null,
  };

  // benchmark damage (dynamic import: benchmark → damage.run → CheckError di file ini)
  let benchmark: BenchmarkSummary | null = null;
  if (input.source === "enka" && input.uid && input.benchmark !== false) {
    try {
      const { runBenchmark, summarize } = await import("./benchmark.service");
      benchmark = summarize(await runBenchmark(input.uid, character.key, { buildIndex: input.buildIndex, erLabel: input.erLabel }));
    } catch (err) {
      console.warn(`[check] benchmark ${character.key} di-skip: ${(err as Error).message}`);
    }
  }

  const result = scoreBuild({
    stats: input.stats,
    guide,
    artifacts: input.artifacts,
    activeSets: input.activeSets,
    weapon: input.weapon,
    constellation: input.constellation,
    talentPriority: parsed.talentPriority ?? null,
    buildIndex: input.buildIndex,
    erLabel: input.erLabel,
    role: getCharacterModule(input.characterKey)?.role ?? null,
    benchmark,
  });

  return {
    character: {
      key: character.key,
      name: character.nameEn,
      element: character.element,
    },
    guide: {
      source: "KQM",
      sourceUrl: g.sourceUrl,
      guideUpdated: g.guideUpdated,
      parsed,
      raw,
    },
    result,
    benchmark,
  };
}
