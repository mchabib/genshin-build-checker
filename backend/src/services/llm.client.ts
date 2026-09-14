import type { ZodType, ZodTypeDef } from "zod";
import { env } from "../env";

/**
 * Client LLM minimal, provider-agnostic: POST {baseUrl}/chat/completions (format OpenAI).
 * Dipakai buat DeepSeek (default), tapi juga jalan ke OpenAI / Ollama / apa pun yang
 * kompatibel — cukup ganti env. Nggak pakai SDK, cuma fetch.
 *
 * `chatJson` minta JSON mode, parse, validasi zod; kalau gagal kirim ulang 1× dengan
 * pesan error-nya supaya model membetulkan.
 */

export class LlmError extends Error {
  constructor(
    public code: "not_configured" | "http" | "timeout" | "invalid_json" | "empty",
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export function isLlmConfigured(): boolean {
  return env.llm.apiKey.trim() !== "";
}

export type Thinking = "on" | "off";
export type ReasoningEffort = "low" | "medium" | "high";

/** Override per-request; kosong = pakai env. */
export interface LlmOptions {
  model?: string;
  thinking?: Thinking;
  effort?: ReasoningEffort;
}

export const THINKING_VALUES: readonly string[] = ["on", "off"];
export const EFFORT_VALUES: readonly string[] = ["low", "medium", "high"];

/** Gabungkan override dengan default env. */
export function resolveLlmOptions(o: LlmOptions = {}): Required<Pick<LlmOptions, "model">> & LlmOptions {
  return {
    model: o.model?.trim() || env.llm.model,
    thinking: o.thinking ?? (env.llm.thinking || undefined),
    effort: o.effort ?? (env.llm.reasoningEffort || undefined),
  };
}

/**
 * Parse input user (CLI flag / query string) jadi LlmOptions. Nilai nggak valid → warning
 * (dikembalikan), bukan error, biar perintah tetap jalan pakai default.
 */
export function parseLlmOptions(raw: { model?: string; thinking?: string; effort?: string }): {
  options: LlmOptions;
  warnings: string[];
} {
  const warnings: string[] = [];
  const options: LlmOptions = {};
  if (raw.model?.trim()) options.model = raw.model.trim();
  if (raw.thinking != null && raw.thinking !== "") {
    const t = raw.thinking.toLowerCase();
    const norm = t === "1" || t === "true" || t === "enabled" ? "on" : t === "0" || t === "false" || t === "disabled" ? "off" : t;
    if (THINKING_VALUES.includes(norm)) options.thinking = norm as Thinking;
    else warnings.push(`--thinking "${raw.thinking}" nggak dikenal (on|off) — pakai default`);
  }
  if (raw.effort != null && raw.effort !== "") {
    const e = raw.effort.toLowerCase();
    if (EFFORT_VALUES.includes(e)) options.effort = e as ReasoningEffort;
    else warnings.push(`--effort "${raw.effort}" nggak dikenal (low|medium|high) — pakai default`);
  }
  return { options, warnings };
}

/** Label singkat buat ditampilkan, mis. "deepseek-v4-pro (thinking on, effort high)". */
export function describeLlmOptions(o: LlmOptions = {}): string {
  const r = resolveLlmOptions(o);
  const bits = [r.thinking ? `thinking ${r.thinking}` : null, r.effort ? `effort ${r.effort}` : null].filter(Boolean);
  return bits.length ? `${r.model} (${bits.join(", ")})` : r.model;
}

export function llmModelName(): string {
  return env.llm.model;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string | null; reasoning_content?: string | null } }[];
  usage?: ChatUsage;
  model?: string;
}

async function chatRaw(
  messages: ChatMessage[],
  opts: { temperature: number; maxTokens: number; json: boolean; llm: LlmOptions },
) {
  if (!isLlmConfigured()) throw new LlmError("not_configured", "LLM_API_KEY belum diisi di backend/.env");
  const r = resolveLlmOptions(opts.llm);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), env.llm.timeoutMs);
  try {
    const res = await fetch(`${env.llm.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.llm.apiKey}`,
      },
      body: JSON.stringify({
        model: r.model,
        messages,
        temperature: opts.temperature,
        max_tokens: opts.maxTokens,
        stream: false,
        ...(opts.json ? { response_format: { type: "json_object" } } : {}),
        // DeepSeek: thinking {type: enabled|disabled}; reasoning_effort low|medium|high (format OpenAI).
        // Cuma dikirim kalau di-set, biar provider lain yang nggak kenal nggak error.
        ...(r.thinking ? { thinking: { type: r.thinking === "on" ? "enabled" : "disabled" } } : {}),
        ...(r.effort && r.thinking !== "off" ? { reasoning_effort: r.effort } : {}),
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new LlmError("http", `LLM HTTP ${res.status}: ${body.slice(0, 300)}`, res.status);
    }
    const data = (await res.json()) as ChatCompletionResponse;
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new LlmError("empty", "LLM balikin respons kosong (max_tokens kehabisan buat thinking?)");
    return { content, usage: data.usage, model: data.model ?? r.model };
  } catch (err) {
    if (err instanceof LlmError) throw err;
    if ((err as Error).name === "AbortError")
      throw new LlmError("timeout", `LLM timeout setelah ${env.llm.timeoutMs}ms`);
    throw new LlmError("http", `LLM request gagal: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Ambil objek JSON dari teks (toleran kalau model bungkus pakai ```json). */
export function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new SyntaxError("nggak ada objek JSON di respons");
  }
}

export interface ChatJsonResult<T> {
  data: T;
  attempts: number;
  usage?: ChatUsage;
  model: string;
  raw: string;
}

export async function chatJson<T>(args: {
  system: string;
  user: string;
  /** T = tipe OUTPUT zod (biar .default() di schema nggak bikin mismatch) */
  schema: ZodType<T, ZodTypeDef, unknown>;
  temperature?: number;
  maxTokens?: number;
  llm?: LlmOptions;
}): Promise<ChatJsonResult<T>> {
  const messages: ChatMessage[] = [
    { role: "system", content: args.system },
    { role: "user", content: args.user },
  ];
  const opts = { temperature: args.temperature ?? 0.2, maxTokens: args.maxTokens ?? 3000, json: true, llm: args.llm ?? {} };
  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { content, usage, model } = await chatRaw(messages, opts);
    try {
      const parsed = args.schema.safeParse(extractJson(content));
      if (parsed.success) return { data: parsed.data, attempts: attempt, usage, model, raw: content };
      lastError = parsed.error.issues
        .slice(0, 8)
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
    } catch (err) {
      lastError = (err as Error).message;
    }
    messages.push(
      { role: "assistant", content },
      {
        role: "user",
        content: `JSON sebelumnya nggak valid: ${lastError}. Balas ULANG hanya dengan objek JSON yang sudah dibetulkan, tanpa teks lain.`,
      },
    );
  }
  throw new LlmError("invalid_json", `LLM gagal kasih JSON valid setelah 2 percobaan: ${lastError}`);
}
