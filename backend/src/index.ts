import { createApp } from "./app";
import { env } from "./env";
import { loadCharacterStore } from "./services/characterStore";
import { loadGuideStore } from "./services/guideStore";
import { loadGameDataStore } from "./services/gameDataStore";
import { loadBuffStore } from "./services/buffStore";

const app = createApp();

const server = app.listen(env.port, () => {
  console.log(`[backend] listening on http://localhost:${env.port}`);
});

// warm-up data statis (mapping avatarId->nama, guide KQM, data talent). Non-fatal kalau gagal.
Promise.all([loadCharacterStore(), loadGuideStore(), loadGameDataStore(), loadBuffStore()]).catch((err) =>
  console.warn("[backend] warm-up store gagal:", err),
);

function shutdown(signal: string) {
  console.log(`[backend] ${signal} received, shutting down`);
  server.close(() => process.exit(0));
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
