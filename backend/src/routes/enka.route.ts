import { Router } from "express";
import { fetchEnkaProfile } from "../services/enka.service";
import { EnkaError } from "../services/enka.types";
import { mapShowcase } from "../services/enka.mapper";
import { loadCharacterStore } from "../services/characterStore";
import { guideKeys, loadGuideStore } from "../services/guideStore";
import { loadGameDataStore } from "../services/gameDataStore";
import { recordUid } from "../services/history.service";

export const enkaRouter = Router();

/** GET /api/enka/:uid — fetch showcase + normalisasi */
enkaRouter.get("/:uid", async (req, res) => {
  try {
    await Promise.all([loadCharacterStore(), loadGuideStore(), loadGameDataStore()]);
    const { data, cached, fetchedAt, cooldownSeconds } = await fetchEnkaProfile(
      req.params.uid,
    );
    const characters = mapShowcase(data);

    // tandai karakter mana yang punya guide KQM
    const withGuide = guideKeys();
    const enriched = characters.map((c) => ({
      ...c,
      checkable: c.key ? withGuide.has(c.key) : false,
    }));

    // catat ke riwayat privat (jangan sampai gagalnya ganggu response)
    void recordUid(req.params.uid, data.playerInfo?.nickname ?? null, data.playerInfo?.level ?? null).catch(() => {});

    res.json({
      player: {
        nickname: data.playerInfo?.nickname ?? null,
        level: data.playerInfo?.level ?? null,
        worldLevel: data.playerInfo?.worldLevel ?? null,
      },
      characters: enriched,
      meta: {
        uid: req.params.uid,
        cached,
        fetchedAt: fetchedAt.toISOString(),
        cooldownSeconds,
        resolvedCount: characters.filter((c) => c.supported).length,
        guideCount: enriched.filter((c) => c.checkable).length,
        totalCount: characters.length,
      },
    });
  } catch (err) {
    if (err instanceof EnkaError) {
      res.status(err.status).json({
        error: err.code,
        message: err.message,
        retryAfterSeconds: err.retryAfterSeconds,
      });
      return;
    }
    console.error("enka route error", err);
    res.status(500).json({ error: "INTERNAL", message: "Kesalahan tak terduga." });
  }
});
