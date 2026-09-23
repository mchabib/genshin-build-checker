import path from "node:path";
import express from "express";
import cors from "cors";
import { env } from "./env";
import { healthRouter } from "./routes/health.route";
import { charactersRouter } from "./routes/characters.route";
import { enkaRouter } from "./routes/enka.route";
import { checkRouter } from "./routes/check.route";
import { assessRouter } from "./routes/assess.route";
import { damageRouter } from "./routes/damage.route";
import { rotationRouter } from "./routes/rotation.route";
import { benchmarkRouter } from "./routes/benchmark.route";
import { primogemsRouter } from "./routes/primogems.route";

export function createApp() {
  const app = express();

  app.use(cors({ origin: env.corsOrigin }));
  app.use(express.json({ limit: "256kb" }));

  // UI sederhana (1 file statis, tanpa build step) -> http://localhost:4000
  app.use(express.static(path.resolve("public")));

  app.use("/api/health", healthRouter);
  app.use("/api/characters", charactersRouter);
  app.use("/api/enka", enkaRouter);
  app.use("/api/check", checkRouter);
  app.use("/api/assess", assessRouter);
  app.use("/api/damage", damageRouter);
  app.use("/api/rotation", rotationRouter);
  app.use("/api/benchmark", benchmarkRouter);
  app.use("/api/primogems", primogemsRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      console.error("unhandled error", err);
      res.status(500).json({ error: "internal_error" });
    },
  );

  return app;
}
