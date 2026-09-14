import { Router } from "express";
import { parseRotationParam, runDamage, DamageError, type DamageReport } from "../services/damage.run";
import { EnkaError } from "../services/enka.types";
import { CheckError } from "../services/check.service";
import { parseLlmOptions } from "../services/llm.client";

export const damageRouter = Router();

/** Buang `context` (bahan prompt, gede) dari response HTTP. */
export function publicReport(r: DamageReport): Omit<DamageReport, "context"> {
  const { context: _ctx, ...rest } = r;
  return rest;
}

/**
 * GET /api/damage/:uid/:characterKey?team=a,b,c&reaction=vaporize&enemyLvl=90&enemyRes=10&catalog=vv_4pc&llm=1&noAssume=1
 *     &rotation=E 9[N1C] Q | na1=9,ca1=9 &duration=20
 * Tabel damage per hit (baseline = self-buff pasti, buffed = + tim/asumsi kondisional). Default OFFLINE
 * (rule + scrape-data/Buffs); `llm=1` pakai LLM buat milih tim/buff/reaksi/rotasi. Angka selalu dari kode.
 */

damageRouter.get("/:uid/:characterKey", async (req, res) => {
  try {
    const q = req.query;
    const str = (k: string) => (typeof q[k] === "string" && (q[k] as string).trim() !== "" ? (q[k] as string) : undefined);
    const num = (k: string) => (str(k) != null ? Number(str(k)) : undefined);
    const lo = parseLlmOptions({ model: str("model"), thinking: str("thinking"), effort: str("effort") });
    const report = await runDamage(req.params.uid, req.params.characterKey, {
      team: str("team")?.split(","),
      reaction: str("reaction"),
      enemyLevel: num("enemyLvl"),
      enemyResPct: num("enemyRes"),
      catalogIds: str("catalog")?.split(","),
      llm: str("llm") != null && !["0", "false", "no"].includes(str("llm")!.toLowerCase()),
      noAssume: ["1", "true"].includes((str("noAssume") ?? "").toLowerCase()),
      llmOptions: lo.options,
      rotation: parseRotationParam(str("rotation")),
      duration: num("duration"),
      stellarHits: num("stellarHits"),
    });
    report.warnings.push(...lo.warnings);
    res.json(publicReport(report));
  } catch (err) {
    if (err instanceof EnkaError) {
      res.status(err.status).json({ error: err.code, message: err.message, retryAfterSeconds: err.retryAfterSeconds });
      return;
    }
    if (err instanceof CheckError) {
      res.status(err.code === "character_not_found" ? 404 : 422).json({ error: err.code, message: err.message });
      return;
    }
    if (err instanceof DamageError) {
      res.status(422).json({ error: err.code, message: err.message });
      return;
    }
    console.error("damage route error", err);
    res.status(500).json({ error: "internal_error" });
  }
});
