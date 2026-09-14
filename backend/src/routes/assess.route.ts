import { Router } from "express";
import { buildAssessBrief } from "../services/assess.service";
import { EnkaError } from "../services/enka.types";
import { CheckError } from "../services/check.service";
import { assessWithLlm } from "../services/assess.llm";
import { isLlmConfigured, LlmError, parseLlmOptions } from "../services/llm.client";

export const assessRouter = Router();

/**
 * GET /api/assess/:uid/:characterKey?er=<label>&build=<n>&llm=1
 * Balikin konteks lengkap 1 karakter (data Enka + cek deterministik + guide KQM mentah).
 * `llm=1` nambah field `llm` = verdict dari LLM (butuh LLM_API_KEY); kalau LLM gagal,
 * `llm: { error }` dan brief tetap dikirim.
 */
assessRouter.get("/:uid/:characterKey", async (req, res) => {
  try {
    const buildRaw = req.query.build;
    const brief = await buildAssessBrief(
      req.params.uid,
      req.params.characterKey,
      {
        erLabel: typeof req.query.er === "string" ? req.query.er : undefined,
        buildIndex:
          typeof buildRaw === "string" && buildRaw.trim() !== ""
            ? Number(buildRaw)
            : undefined,
      },
    );
    const wantLlm = typeof req.query.llm === "string" && !["0", "false", "no", ""].includes(req.query.llm.toLowerCase());
    if (!wantLlm) {
      res.json(brief);
      return;
    }
    if (!isLlmConfigured()) {
      res.json({ ...brief, llm: { error: "LLM_API_KEY belum diisi" } });
      return;
    }
    try {
      const q = (k: string) => (typeof req.query[k] === "string" ? (req.query[k] as string) : undefined);
      const lo = parseLlmOptions({ model: q("model"), thinking: q("thinking"), effort: q("effort") });
      const llm = await assessWithLlm(brief, lo.options);
      res.json({ ...brief, llm: { ...llm, warnings: lo.warnings } });
    } catch (err) {
      const msg = err instanceof LlmError ? `${err.code}: ${err.message}` : (err as Error).message;
      res.json({ ...brief, llm: { error: msg } });
    }
  } catch (err) {
    if (err instanceof EnkaError) {
      res.status(err.status).json({
        error: err.code,
        message: err.message,
        retryAfterSeconds: err.retryAfterSeconds,
      });
      return;
    }
    if (err instanceof CheckError) {
      res
        .status(err.code === "character_not_found" ? 404 : 422)
        .json({ error: err.code, message: err.message });
      return;
    }
    console.error("assess route error", err);
    res.status(500).json({ error: "internal_error" });
  }
});
