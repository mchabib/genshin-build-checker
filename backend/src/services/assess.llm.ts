import { z } from "zod";
import { chatJson, describeLlmOptions, type ChatUsage, type LlmOptions } from "./llm.client";
import { formatAssessBrief, type AssessBrief } from "./assess.service";

/**
 * Verdict build ala "format (b)" yang sudah disepakati di Fase 1, sekarang dari LLM beneran
 * (sebelumnya brief-nya dibaca manual). Input = formatAssessBrief().
 * Nilai utamanya: LLM boleh meng-override flag deterministik yang salah konteks
 * (mis. shielder nggak butuh crit, burst tiap 2 rotasi nggak butuh ER tinggi).
 */
export const AssessLlmSchema = z.object({
  verdict: z.string().min(1),
  grade: z.enum(["S", "A", "B", "C", "D"]).optional(),
  strengths: z.array(z.string()).max(8).default([]),
  issues: z.array(z.string()).max(8).default([]),
  priorities: z.array(z.string()).max(6).default([]),
  overrides: z.array(z.string()).max(6).default([]),
});
export type AssessLlmResult = z.infer<typeof AssessLlmSchema> & { model: string; usage?: ChatUsage; attempts: number };

const SYSTEM = [
  "Kamu reviewer build Genshin Impact yang berpengalaman (referensi utama: KQM). Kamu dapat brief 1 karakter: data Enka (stat total, artifact, senjata, talent, constellation), hasil cek deterministik berbasis aturan, dan teks guide KQM mentah.",
  "Tugasmu: kasih verdict holistik dalam Bahasa Indonesia santai. Yang paling penting: KOREKSI flag deterministik yang salah konteks (contoh: Zhongli shielder nggak butuh crit → 'fail crit' itu false alarm; Alhaitham Spread DPS burst tiap 2 rotasi → ER 'fail' kegalakan). Sebut override-nya eksplisit di `overrides`.",
  "Jangan mengarang angka; pakai angka dari brief. Rekomendasi harus konkret dan urut prioritas (mis. 'ganti goblet EM → Dendro DMG', 'naikin talent E ke 9').",
  "Balas HANYA JSON: {verdict: string (1-2 kalimat), grade?: S|A|B|C|D, strengths: string[], issues: string[], priorities: string[] (urut), overrides: string[]}.",
].join("\n");

export async function assessWithLlm(brief: AssessBrief, llm: LlmOptions = {}): Promise<AssessLlmResult> {
  const res = await chatJson({
    system: SYSTEM,
    user: formatAssessBrief(brief) + "\n\nBalas hanya JSON.",
    schema: AssessLlmSchema,
    temperature: 0.3,
    maxTokens: 6000,
    llm,
  });
  return { ...res.data, model: describeLlmOptions({ ...llm, model: res.model }), usage: res.usage, attempts: res.attempts };
}

export function formatAssessLlm(r: AssessLlmResult): string {
  const L: string[] = [];
  L.push(`Verdict${r.grade ? ` (${r.grade})` : ""}: ${r.verdict}`);
  if (r.strengths.length) {
    L.push("🟢 Yang udah bagus:");
    for (const s of r.strengths) L.push(`  - ${s}`);
  }
  if (r.issues.length) {
    L.push("🔴 Yang perlu dibenerin:");
    for (const s of r.issues) L.push(`  - ${s}`);
  }
  if (r.priorities.length) {
    L.push("To-do (urut prioritas):");
    r.priorities.forEach((s, i) => L.push(`  ${i + 1}. ${s}`));
  }
  if (r.overrides.length) {
    L.push("Override flag deterministik:");
    for (const s of r.overrides) L.push(`  - ${s}`);
  }
  const rt = r.usage?.completion_tokens_details?.reasoning_tokens;
  L.push(`(${r.model}${r.usage?.total_tokens ? `, ${r.usage.total_tokens} token${rt ? `, ${rt} reasoning` : ""}` : ""})`);
  return L.join("\n");
}
