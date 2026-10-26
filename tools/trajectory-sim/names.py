"""Public trajectory filenames for the launches page.

Surrogate:  <slug>_<YYYY-MM-DD>_trajectory.csv / .kml
3DOF sim:   <slug>_<YYYY-MM-DD>_trajectory_sim.csv / .kml

The simulator's own out/ files stay <slug>_ascent_ecef_5s_sim.csv and
<slug>_ascent_sim.kml. publish_sim copies those into the public names.
"""
import os
import shutil


def trajectory_basename(slug, t0_utc, sim=False, ext="csv"):
    date = str(t0_utc)[:10]
    if len(date) != 10 or date[4] != "-" or date[7] != "-":
        raise ValueError(f"t0_utc must start with YYYY-MM-DD, got {t0_utc!r}")
    if ext not in ("csv", "kml"):
        raise ValueError(ext)
    kind = "trajectory_sim" if sim else "trajectory"
    return f"{slug}_{date}_{kind}.{ext}"


def publish_sim(slug, t0_utc, csv_path, kml_path, public_root=None):
    """Copy a sim CSV and KML into public/launches/<slug>/ under the public names."""
    here = os.path.dirname(os.path.abspath(__file__))
    root = public_root or os.path.normpath(
        os.path.join(here, "..", "..", "artifacts", "space-report", "public")
    )
    dest = os.path.join(root, "launches", slug)
    os.makedirs(dest, exist_ok=True)
    written = []
    for src, ext in ((csv_path, "csv"), (kml_path, "kml")):
        name = trajectory_basename(slug, t0_utc, sim=True, ext=ext)
        target = os.path.join(dest, name)
        shutil.copyfile(src, target)
        written.append(target)
    return written
