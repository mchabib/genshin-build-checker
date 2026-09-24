export const env = {
  port: Number(process.env.PORT ?? 4000),
  /** Token buat endpoint privat (/api/history). Kosong = endpoint-nya dikunci total. */
  adminToken: (process.env.ADMIN_TOKEN ?? "").trim(),
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
  enka: {
    baseUrl: process.env.ENKA_BASE_URL ?? "https://enka.network",
    userAgent:
      process.env.ENKA_USER_AGENT ?? "GenshinBuildChecker/0.1 (personal project)",
    cacheTtlSeconds: Number(process.env.ENKA_CACHE_TTL_SECONDS ?? 90),
  },
  /**
   * LLM OpenAI-compatible (DeepSeek default). Mati kalau `LLM_ENABLED` bukan true/1/on
   * ATAU `LLM_API_KEY` kosong. Default MATI — biar instance yang di-hosting nggak kebakaran
   * kuota API-nya gara-gara dipakai orang lain.
   */
  llm: {
    enabled: ["1", "true", "on", "ya"].includes((process.env.LLM_ENABLED ?? "").trim().toLowerCase()),
    baseUrl: (process.env.LLM_BASE_URL ?? "https://api.deepseek.com").replace(/\/+$/, ""),
    apiKey: process.env.LLM_API_KEY ?? "",
    model: process.env.LLM_MODEL ?? "deepseek-chat",
    /** "on" | "off" | "" (default provider). DeepSeek: flash/v4-pro default ON, deepseek-chat = OFF */
    thinking: (process.env.LLM_THINKING ?? "").toLowerCase() as "on" | "off" | "",
    /** "low" | "medium" | "high" | "" (default provider). Cuma dipakai kalau thinking aktif. */
    reasoningEffort: (process.env.LLM_REASONING_EFFORT ?? "").toLowerCase() as "low" | "medium" | "high" | "",
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 120000),
  },
};
