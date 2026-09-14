import { Router } from "express";
import { runTeamRotation, RotationError } from "../services/rotation.run";
import { EnkaError } from "../services/enka.types";
import { CheckError } from "../services/check.service";
import { DamageError } from "../services/damage.run";

export const rotationRouter = Router();

/**
 * GET /api/rotation/:uid?r=Yae%203[E]%20%3E%20Odette%202[E]%20%3E%20Sandrone%203[C%20E]%20Q&enemyLvl=90&enemyRes=10&noAssume=1
 * Rotasi tim dari notasi KQM: tiap karakter dihitung dengan modulnya, tim = karakter lain di urutan.
 */
rotationRouter.get("/:uid", async (req, res) => {
  try {
    const q = req.query;
    const str = (k: string) => (typeof q[k] === "string" && (q[k] as string).trim() !== "" ? (q[k] as string) : undefined);
    const notation = str("r");
    if (!notation) {
      res.status(400).json({ error: "bad_notation", message: "query `r` (notasi rotasi) wajib" });
      return;
    }
    const result = await runTeamRotation(req.params.uid, notation, {
      enemyLevel: str("enemyLvl") ? Number(str("enemyLvl")) : undefined,
      enemyResPct: str("enemyRes") ? Number(str("enemyRes")) : undefined,
      noAssume: ["1", "true"].includes((str("noAssume") ?? "").toLowerCase()),
      catalogIds: str("catalog")?.split(","),
      reaction: str("reaction"),
      stellarHits: str("stellarHits") ? Number(str("stellarHits")) : undefined,
      duration: str("duration") ? Number(str("duration")) : undefined,
    });
    res.json(result);
  } catch (err) {
    if (err instanceof EnkaError) {
      res.status(err.status).json({ error: err.code, message: err.message });
      return;
    }
    if (err instanceof CheckError || err instanceof DamageError || err instanceof RotationError) {
      res.status(422).json({ error: err.code, message: err.message });
      return;
    }
    console.error("rotation route error", err);
    res.status(500).json({ error: "internal_error" });
  }
});
