import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { CatalogLoadingError } from "./lib/obc/store";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// ── Error handlers ─────────────────────────────────────────────────────────
// Must be registered AFTER the router (Express identifies error handlers by
// their 4-argument signature).

// 503 while the catalog is still loading on a cold start
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof CatalogLoadingError) {
    res.status(503).json({
      error: "catalog_loading",
      message: "The satellite catalogue is still loading. Please retry in a few seconds.",
      retryAfterSeconds: 5,
    });
    return;
  }
  // Re-surface any other error as a 500
  logger.error({ err }, "unhandled route error");
  res.status(500).json({ error: "internal_server_error" });
});

export default app;
