import { Router, type IRouter } from "express";
import { getTle } from "../lib/tle";
import { predictPasses, predictPassesFromEphemeris } from "../lib/passes";
import { catalogNameForNorad, loadEphemerisForName } from "../lib/obc/starlinkEphem";

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
  const noradRaw = parseInt(String(req.query["norad"] ?? ""), 10);
  const norad = Number.isFinite(noradRaw) && noradRaw > 0 ? noradRaw : 0;
  const nameQuery = String(req.query["name"] ?? "").trim();
  const lat = parseFloat(String(req.query["lat"] ?? ""));
  const lon = parseFloat(String(req.query["lon"] ?? ""));
  const days = Math.min(7, Math.max(1, parseInt(String(req.query["days"] ?? "3"), 10) || 3));

  if (!norad && !nameQuery) {
    res.status(400).json({ error: "Need a NORAD id or a satellite name" });
    return;
  }
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
    res.status(400).json({ error: "Invalid coordinates" });
    return;
  }

  try {
    const name = nameQuery || (norad ? await catalogNameForNorad(norad) : null) || "";
    if (name) {
      try {
        const ephem = await loadEphemerisForName(name);
        if (ephem) {
          const passes = predictPassesFromEphemeris(ephem.samples, lat, lon, days);
          res.json({
            norad,
            name,
            lat,
            lon,
            days,
            epoch: new Date(ephem.startMs).toISOString(),
            coverageEnd: new Date(ephem.stopMs).toISOString(),
            source: "starlink-ephemeris",
            passes,
          });
          return;
        }
      } catch (err) {
        if (!norad) {
          req.log.error({ err, name }, "starlink ephemeris fetch failed");
          res.status(502).json({ error: "Starlink ephemeris unavailable" });
          return;
        }
        req.log.warn({ err, name }, "starlink ephemeris failed, falling back to TLE");
      }
    }

    if (!norad) {
      res.status(404).json({ error: "No public ephemeris on file for this object" });
      return;
    }
    const tle = await getTle(norad);
    if (!tle) {
      res.status(404).json({ error: "No element set on file for this object" });
      return;
    }
    const passes = predictPasses(tle, lat, lon, days);
    res.json({ norad, lat, lon, days, epoch: tle.epoch, source: "tle", passes });
  } catch (err) {
    req.log.error({ err, norad, name: nameQuery }, "pass prediction failed");
    res.status(502).json({ error: "space-track.org unavailable" });
  }
});

export default router;
