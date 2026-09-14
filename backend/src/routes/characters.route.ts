import { Router } from "express";
import {
  allResolved,
  loadCharacterStore,
  resolveByKey,
} from "../services/characterStore";
import { getGuide, hasGuide, loadGuideStore } from "../services/guideStore";

export const charactersRouter = Router();

/** GET /api/characters — daftar karakter + status guide */
charactersRouter.get("/", async (_req, res) => {
  await Promise.all([loadCharacterStore(), loadGuideStore()]);
  const characters = allResolved()
    .map((c) => ({
      key: c.key,
      name: c.nameEn,
      localizedName: c.name,
      element: c.element,
      weaponType: c.weaponType,
      rarity: c.rarity,
      enkaAvatarId: c.avatarId,
      hasGuide: hasGuide(c.key),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json({ characters });
});

/** GET /api/characters/:key — detail + guide lengkap */
charactersRouter.get("/:key", async (req, res) => {
  await Promise.all([loadCharacterStore(), loadGuideStore()]);
  const character = resolveByKey(req.params.key);
  if (!character) {
    res.status(404).json({ error: "character_not_found", key: req.params.key });
    return;
  }
  res.json({
    character: {
      key: character.key,
      name: character.nameEn,
      localizedName: character.name,
      element: character.element,
      weaponType: character.weaponType,
      rarity: character.rarity,
      enkaAvatarId: character.avatarId,
    },
    guide: getGuide(character.key),
  });
});
