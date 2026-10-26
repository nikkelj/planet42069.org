import express, { type Express, type NextFunction, type Request, type Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { contentDisposition, safePublicFile, trajectoryAttachmentName } from "./lib/trajectory-file.ts";

export function createApp(publicDir: string): Express {
  const root = path.resolve(publicDir);
  const app = express();
  app.disable("x-powered-by");

  app.use((req: Request, res: Response, next: NextFunction) => {
    const name = trajectoryAttachmentName(req.path);
    if (name) {
      const abs = safePublicFile(root, req.path);
      if (abs && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        res.setHeader("Content-Disposition", contentDisposition(name));
      }
    }
    next();
  });

  // Don't 301 /launches to /launches/. That path is the SPA route, and the
  // public/launches directory would otherwise steal it.
  app.use(express.static(root, { fallthrough: true, index: ["index.html"], redirect: false }));

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.status(404).end();
      return;
    }
    res.sendFile(path.join(root, "index.html"), (err) => {
      if (err) next(err);
    });
  });

  return app;
}

const entry = process.argv[1];
const isMain = entry !== undefined && import.meta.url === pathToFileURL(path.resolve(entry)).href;

if (isMain) {
  const port = Number(process.env.PORT);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error("PORT environment variable is required but was not provided.");
  }
  const publicDir = path.resolve(import.meta.dirname, "..", "dist", "public");
  const app = createApp(publicDir);
  app.listen(port, "0.0.0.0", () => {
    console.log(`space-report listening on ${port}`);
  });
}
