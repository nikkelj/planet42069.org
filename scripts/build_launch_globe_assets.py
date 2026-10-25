#!/usr/bin/env python3
"""Build lightweight assets for the Launches 3D globe (LaunchGlobe.tsx).

1. track_lite.json per launch: decimated [lat, lon, alt_km] (<=600 pts) for the
   surrogate (trajectory.csv) and first-principles sim (trajectory_sim.csv),
   plus elapsed seconds, so the browser never downloads the full CSVs.
2. (optional, --textures DAY NIGHT) Earth textures as WebP: 2048 / 512 px
   placeholders, from NASA Blue Marble (day) and Black Marble 2016 (night).
Adds files.track_lite to public/launches/index.json.

Usage: python3 scripts/build_launch_globe_assets.py [--textures day.jpg night.jpg]
"""
import csv, json, sys, os
ROOT = os.path.join(os.path.dirname(__file__), "..", "artifacts", "space-report", "public")
MAXP = 600

COAST_STEP_S = 30  # post-cutoff coast rows (sims run through payload deploy) are thinned to keep the globe fast

def lite(path):
    with open(path) as f:
        rows = list(csv.DictReader(l for l in f if not l.startswith("#")))
    asc = [r for r in rows if not r["source"].endswith("-coast")]
    coast = [r for r in rows if r["source"].endswith("-coast")]
    if coast:  # keep powered/ascent rows, thin the long coast (always keep its last row = deploy)
        keep = [r for r in coast if float(r["elapsed_s"]) % COAST_STEP_S == 0]
        if not keep or keep[-1] is not coast[-1]:
            keep.append(coast[-1])
        rows = sorted(asc + keep, key=lambda r: float(r["elapsed_s"]))
    step = max(1, -(-len(rows) // MAXP))
    pick = rows[::step]
    if pick[-1] is not rows[-1]:
        pick.append(rows[-1])
    return [[round(float(r["elapsed_s"]), 1), round(float(r["lat_deg"]), 4),
             round(float(r["lon_deg"]), 4), round(float(r["altitude_km"]), 2)] for r in pick]

def main():
    idx_path = os.path.join(ROOT, "launches", "index.json")
    idx = json.load(open(idx_path))
    for L in idx["launches"]:
        out = {"slug": L["slug"], "fields": ["t_s", "lat", "lon", "alt_km"]}
        for key, name in (("csv", "surrogate"), ("csv_sim", "sim")):
            p = L["files"].get(key)
            if p:
                out[name] = lite(os.path.join(ROOT, p.lstrip("/")))
        rel = f"/launches/{L['slug']}/track_lite.json"
        with open(os.path.join(ROOT, rel.lstrip("/")), "w") as f:
            json.dump(out, f, separators=(",", ":"))
        L["files"]["track_lite"] = rel
    with open(idx_path, "w") as f:
        json.dump(idx, f, indent=2, ensure_ascii=False); f.write("\n")
    if "--textures" in sys.argv:
        from PIL import Image
        i = sys.argv.index("--textures"); day, night = sys.argv[i + 1], sys.argv[i + 2]
        od = os.path.join(ROOT, "launches", "globe")
        os.makedirs(od, exist_ok=True)
        Image.MAX_IMAGE_PIXELS = None
        for src, nm, q in ((day, "earth_day", 82), (night, "earth_night", 70)):
            im = Image.open(src).convert("RGB")
            im.resize((4096, 2048), Image.LANCZOS).save(f"{od}/{nm}_4k.webp", quality=q, method=6)
            im.resize((512, 256), Image.LANCZOS).save(f"{od}/{nm}_512.webp", quality=60)
main()
