import { Router } from "express";
import { runBenchmark } from "../services/benchmark.service";
import { parseRotationParam, DamageError } from "../services/damage.run";
import { EnkaError } from "../services/enka.types";
import { CheckError } from "../services/check.service";

export const benchmarkRouter = Router();

/**
 * GET /api/benchmark/:uid/:characterKey?build=0&er=label&erTarget=160&team=a,b,c&rotation=...&duration=20&noAssume=1
 * Build user vs build acuan (artifact standar KQMS, sisanya sama) → ratio + delta stat.
 */
benchmarkRouter.get("/:uid/:characterKey", async (req, res) => {
  try {
    const q = req.query;
    const str = (k: string) => (typeof q[k] === "string" && (q[k] as string).trim() !== "" ? (q[k] as string) : undefined);
    const num = (k: string) => (str(k) != null ? Number(str(k)) : undefined);
    const report = await runBenchmark(req.params.uid, req.params.characterKey, {
      team: str("team")?.split(","),
      reaction: str("reaction"),
      enemyLevel: num("enemyLvl"),
      enemyResPct: num("enemyRes"),
      catalogIds: str("catalog")?.split(","),
      rotation: parseRotationParam(str("rotation")),
      duration: num("duration"),
      stellarHits: num("stellarHits"),
      noAssume: ["1", "true"].includes((str("noAssume") ?? "").toLowerCase()),
      buildIndex: num("build"),
      erLabel: str("er"),
      erTarget: num("erTarget"),
    });
    // report damage lengkap gede; default cuma ringkasan (full=1 buat semua)
    if (!["1", "true"].includes((str("full") ?? "").toLowerCase())) {
      const { reports: _r, ...rest } = report;
      res.json(rest);
      return;
    }
    res.json(report);
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
    console.error("benchmark route error", err);
    res.status(500).json({ error: "internal_error" });
  }
});
