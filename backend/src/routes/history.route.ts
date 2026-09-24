import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { env } from "../env";
import { clearHistory, historyStats } from "../services/history.service";

export const historyRouter = Router();

/** Bandingin token tanpa bocorin panjang/isi lewat waktu eksekusi. */
function tokenOk(given: string | undefined): boolean {
  const want = env.adminToken;
  if (!want || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

function guard(req: { query: Record<string, unknown>; headers: Record<string, unknown> }): string | null {
  if (!env.adminToken)
    return "ADMIN_TOKEN belum diisi di backend/.env — riwayat sengaja dikunci sampai token diisi.";
  const given = (typeof req.query.token === "string" ? req.query.token : undefined) ?? (req.headers["x-admin-token"] as string | undefined);
  return tokenOk(given) ? null : "token salah";
}

/**
 * GET /api/history?token=...&limit=100&sort=count|lastSeen
 * Riwayat UID yang pernah dicek + berapa kali. KHUSUS pemilik instance (butuh ADMIN_TOKEN).
 */
historyRouter.get("/", async (req, res) => {
  const err = guard(req as never);
  if (err) {
    res.status(env.adminToken ? 403 : 503).json({ error: "forbidden", message: err });
    return;
  }
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
  const sort = req.query.sort === "count" ? "count" : "lastSeen";
  res.json(await historyStats({ limit, sort }));
});

/** DELETE /api/history?token=... — kosongkan riwayat. */
historyRouter.delete("/", async (req, res) => {
  const err = guard(req as never);
  if (err) {
    res.status(env.adminToken ? 403 : 503).json({ error: "forbidden", message: err });
    return;
  }
  res.json({ cleared: await clearHistory() });
});
