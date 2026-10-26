import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "@/server.ts";
import { contentDisposition, trajectoryAttachmentName } from "@/lib/trajectory-file.ts";

describe("trajectory Content-Disposition", () => {
  const servers: Server[] = [];

  afterEach(() => {
    for (const server of servers) server.close();
    servers.length = 0;
  });

  it("names only slug_date trajectory files", () => {
    expect(trajectoryAttachmentName("/launches/starlink-15-16/starlink-15-16_2026-10-27_trajectory.csv")).toBe(
      "starlink-15-16_2026-10-27_trajectory.csv",
    );
    expect(trajectoryAttachmentName("/launches/lm8a-wenchang/lm8a-wenchang_2026-10-25_trajectory_sim.kml?x=1")).toBe(
      "lm8a-wenchang_2026-10-25_trajectory_sim.kml",
    );
    expect(trajectoryAttachmentName("/launches/starlink-15-16/trajectory.csv")).toBeNull();
    expect(trajectoryAttachmentName("/launches/index.json")).toBeNull();
    expect(trajectoryAttachmentName("/index.html")).toBeNull();
  });

  it("serves trajectory files as attachments and leaves the page alone", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "traj-"));
    const folder = path.join(dir, "launches", "starlink-15-16");
    fs.mkdirSync(folder, { recursive: true });
    const name = "starlink-15-16_2026-10-27_trajectory.csv";
    fs.writeFileSync(path.join(folder, name), "elapsed_s,lat_deg\n0,0\n");
    fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>launches</title>");
    fs.writeFileSync(path.join(dir, "launches", "index.json"), "{}");

    const server = createApp(dir).listen(0, "127.0.0.1");
    servers.push(server);
    await once(server, "listening");
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const file = await fetch(`http://127.0.0.1:${port}/launches/starlink-15-16/${name}`);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-disposition")).toBe(contentDisposition(name));
    expect(await file.text()).toContain("elapsed_s");

    const page = await fetch(`http://127.0.0.1:${port}/launches`, { redirect: "manual" });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-disposition")).toBeNull();
    expect(await page.text()).toContain("launches");

    const manifest = await fetch(`http://127.0.0.1:${port}/launches/index.json`);
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get("content-disposition")).toBeNull();
  });
});
