import { Router } from "express";
import { allResolved, loadCharacterStore } from "../services/characterStore";
import { guideStoreStats, loadGuideStore } from "../services/guideStore";
import { gameDataStats, loadGameDataStore } from "../services/gameDataStore";
import { buffStoreStats, loadBuffStore } from "../services/buffStore";
import { isLlmConfigured, llmDisabledReason } from "../services/llm.client";

export const healthRouter = Router();

healthRouter.get("/", async (_req, res) => {
  await Promise.all([loadCharacterStore(), loadGuideStore(), loadGameDataStore(), loadBuffStore()]);
  const stats = guideStoreStats();
  const gd = gameDataStats();
  const b = buffStoreStats();
  res.json({
    status: "ok",
    characters: allResolved().length,
    guides: stats.guides,
    talents: gd.talents,
    weapons: gd.weapons,
    artifacts: gd.artifacts,
    buffModules: b.modules,
    buffEntries: b.team + b.sets + b.weapons,
    llm: { enabled: isLlmConfigured(), reason: llmDisabledReason() },
    llmConfigured: isLlmConfigured(),
    time: new Date().toISOString(),
  });
});
