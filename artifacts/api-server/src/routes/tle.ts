import { Router, type IRouter } from "express";
import { getTle } from "../lib/tle";
import { predictPasses } from "../lib/passes";

const router: IRouter = Router();

router.get("/satcat/tle/:norad", async (req, res): Promise<void> => {
  const norad = parseInt(String(req.params["norad"]), 10);
  if (!Number.isFinite(norad) || norad <= 0) {
    res.status(400).json({ error: "Invalid NORAD id" });
    return;
  }
  try {
    const tle = await getTle(norad);
    if (!tle) {
      res.status(404).json({ error: "No element set on file for this object" });
      return;
    }
    res.json(tle);
  } catch (err) {
    req.log.error({ err, norad }, "TLE fetch failed");
    res.status(502).json({ error: "space-track.org unavailable" });
  }
});

router.get("/satcat/passes", async (req, res): Promise<void> => {
  const norad = parseInt(String(req.query["norad"] ?? ""), 10);
  const lat = parseFloat(String(req.query["lat"] ?? ""));
  const lon = parseFloat(String(req.query["lon"] ?? ""));
  const days = Math.min(7, Math.max(1, parseInt(String(req.query["days"] ?? "3"), 10) || 3));

  if (!Number.isFinite(norad) || norad <= 0) {
    res.status(400).json({ error: "Invalid NORAD id" });
    return;
  }
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
    res.status(400).json({ error: "Invalid coordinates" });
    return;
  }

  try {
    const tle = await getTle(norad);
    if (!tle) {
      res.status(404).json({ error: "No element set on file for this object" });
      return;
    }
    const passes = predictPasses(tle, lat, lon, days);
    res.json({ norad, lat, lon, days, epoch: tle.epoch, passes });
  } catch (err) {
    req.log.error({ err, norad }, "pass prediction failed");
    res.status(502).json({ error: "space-track.org unavailable" });
  }
});

export default router;
