export interface Benchmark {
  id: number;
  role: string;
  label: string;
  source: string;
  critRateMin: number | null;
  critDmgMin: number | null;
  critValueMin: number | null;
  erMin: number | null;
  erMax: number | null;
  emMin: number | null;
  notes: string | null;
  isDefault: boolean;
}

export interface Character {
  id: number;
  key: string;
  enkaAvatarId: number;
  name: string;
  element: string;
  weaponType: string;
  rarity: number;
  benchmarks: Benchmark[];
}

export interface NormalizedStats {
  critRate: number;
  critDmg: number;
  energyRecharge: number;
  elementalMastery: number;
  atkPercent?: number;
  hpPercent?: number;
  defPercent?: number;
  elementalDmgBonus?: number;
}

export interface ShowcaseArtifact {
  slot: string;
  setName: string | null;
  level: number;
  rarity: number;
  mainStat: { key: string; label: string; value: number };
  substats: { key: string; label: string; value: number }[];
}

export interface ShowcaseCharacter {
  enkaAvatarId: number;
  key: string | null;
  name: string;
  element: string | null;
  /** nama karakter ke-resolve dari Enka store */
  supported: boolean;
  /** ada benchmark di DB -> tombol "Cek build" aktif */
  checkable: boolean;
  level: number | null;
  stats: NormalizedStats;
  artifacts: ShowcaseArtifact[];
  sets: { name: string; count: number }[];
  substatTotals: Record<string, number>;
  substatCritValue: number;
}

export interface EnkaResult {
  player: { nickname: string | null; level: number | null; worldLevel: number | null };
  characters: ShowcaseCharacter[];
  meta: {
    uid: string;
    cached: boolean;
    fetchedAt: string;
    cooldownSeconds: number;
    resolvedCount: number;
    checkableCount: number;
    totalCount: number;
  };
}

export type CheckStatus = "pass" | "warn" | "fail" | "skip";

export interface CheckLine {
  key: string;
  label: string;
  status: CheckStatus;
  actual: number | null;
  target: string;
  message: string;
}

export interface ScoringResult {
  passed: boolean;
  score: number;
  grade: "S" | "A" | "B" | "C" | "D";
  checks: CheckLine[];
  recommendations: string[];
}

export interface CheckResponse {
  checkRunId: number;
  character: { key: string; name: string; element: string };
  benchmark: { id: number; label: string; role: string; source: string; notes: string | null };
  result: ScoringResult;
}

export interface ApiError {
  error: string;
  message?: string;
  retryAfterSeconds?: number;
}
