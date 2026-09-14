import type {
  Character,
  CheckResponse,
  EnkaResult,
  NormalizedStats,
} from "./types";

const BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000";

export class ApiRequestError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiRequestError(
      body.error ?? "unknown",
      body.message ?? `HTTP ${res.status}`,
      res.status,
      body.retryAfterSeconds,
    );
  }
  return body as T;
}

export const api = {
  listCharacters: () =>
    request<{ characters: Character[] }>("/api/characters").then((r) => r.characters),

  fetchEnka: (uid: string) =>
    request<EnkaResult>(`/api/enka/${encodeURIComponent(uid)}`),

  check: (payload: {
    source: "enka" | "manual";
    characterKey: string;
    benchmarkId?: number;
    stats: NormalizedStats;
    substatCritValue?: number;
    substatTotals?: Record<string, number>;
    uid?: string;
  }) =>
    request<CheckResponse>("/api/check", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
};
