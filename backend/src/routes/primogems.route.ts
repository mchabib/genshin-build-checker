import { Router } from "express";
import { planPrimogems, primogemSources, loadPrimogemStore, PrimogemError } from "../services/primogem.service";

export const primogemsRouter = Router();

/** Pilihan yang tersedia (buat isi dropdown UI). */
primogemsRouter.get("/sources", async (_req, res) => {
  await loadPrimogemStore();
  const s = primogemSources();
  if (!s) {
    res.status(500).json({ error: "no_data", message: "scrape-data/Primogems/_sources.json nggak ada / rusak." });
    return;
  }
  res.json(s);
});

/**
 * GET /api/primogems?to=2026-11-05&from=&welkin=1&bp=paid&abyssStars=36&theater=visionary&stygian=hard
 *                    &events=1&extra=0&currentPrimogems=0&currentFates=0
 * Estimasi income primogem sampai tanggal target → total primo/fate → berapa wish.
 */
primogemsRouter.get("/", async (req, res) => {
  try {
    const q = req.query;
    const str = (k: string) => (typeof q[k] === "string" && (q[k] as string).trim() !== "" ? (q[k] as string).trim() : undefined);
    const num = (k: string) => (str(k) != null ? Number(str(k)) : undefined);
    const bool = (k: string, dflt: boolean) => (str(k) == null ? dflt : ["1", "true", "ya"].includes(str(k)!.toLowerCase()));
    const to = str("to");
    if (!to) {
      res.status(400).json({ error: "bad_date", message: "query `to` (tanggal target, YYYY-MM-DD) wajib" });
      return;
    }
    const report = await planPrimogems({
      from: str("from"),
      to,
      welkin: bool("welkin", false),
      stardust: bool("stardust", false),
      battlePass: str("bp"),
      bpLevel: num("bpLevel"),
      abyssStars: num("abyssStars"),
      theater: str("theater"),
      stygian: str("stygian"),
      events: bool("events", true),
      extraPrimogems: num("extra"),
      currentPrimogems: num("currentPrimogems"),
      currentFates: num("currentFates"),
    });
    res.json(report);
  } catch (err) {
    if (err instanceof PrimogemError) {
      res.status(err.code === "no_data" ? 500 : 400).json({ error: err.code, message: err.message });
      return;
    }
    console.error("primogems route error", err);
    res.status(500).json({ error: "internal_error" });
  }
});
