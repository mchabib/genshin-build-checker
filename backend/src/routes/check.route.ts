import { Router } from "express";
import { z } from "zod";
import { runCheck, CheckError } from "../services/check.service";

export const checkRouter = Router();

const statsSchema = z.object({
  critRate: z.number().min(0).max(200).default(5),
  critDmg: z.number().min(0).max(1000).default(50),
  energyRecharge: z.number().min(0).max(600).default(100),
  elementalMastery: z.number().min(0).max(2000).default(0),
  atkPercent: z.number().min(0).max(400).optional(),
  hpPercent: z.number().min(0).max(400).optional(),
  defPercent: z.number().min(0).max(400).optional(),
  elementalDmgBonus: z.number().min(0).max(400).optional(),
});

const artifactSchema = z.object({
  slot: z.string(),
  mainStat: z.string(),
  substats: z.array(z.object({ stat: z.string(), value: z.number() })).default([]),
});

const bodySchema = z.object({
  source: z.enum(["enka", "manual"]),
  characterKey: z.string().min(1),
  stats: statsSchema,
  artifacts: z.array(artifactSchema).optional(),
  activeSets: z.array(z.object({ name: z.string(), count: z.number() })).optional(),
  weapon: z
    .object({
      name: z.string().nullable(),
      refinement: z.number().int().min(1).max(5),
      secondaryStat: z.string().nullable(),
    })
    .nullish(),
  constellation: z.number().int().min(0).max(6).optional(),
  buildIndex: z.number().int().min(0).optional(),
  erLabel: z.string().optional(),
  uid: z.string().optional(),
});

checkRouter.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });
    return;
  }
  try {
    const out = await runCheck(parsed.data);
    res.json(out);
  } catch (err) {
    if (err instanceof CheckError) {
      res.status(err.code === "character_not_found" ? 404 : 422).json({
        error: err.code,
        message: err.message,
      });
      return;
    }
    console.error("check route error", err);
    res.status(500).json({ error: "internal_error" });
  }
});
