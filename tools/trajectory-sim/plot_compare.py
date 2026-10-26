import json,csv,os,matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
from names import trajectory_basename
R=os.path.normpath(os.path.join(os.path.dirname(__file__),"..","..","artifacts","space-report","public","launches"))
DATES={"electron-hawkeye360":"2026-10-23","lm6a-yaogan50-03":"2026-10-23","lm4b-jiuquan":"2026-10-23","lm8a-wenchang":"2026-10-25"}
def rd(fn):
    rows=[r for r in csv.DictReader(l for l in open(fn) if not l.startswith("#"))]
    return [float(r["elapsed_s"]) for r in rows],[float(r["altitude_km"]) for r in rows]
fig,ax=plt.subplots(2,3,figsize=(16,9)); ax=ax.ravel()
for i,s in enumerate(["electron-hawkeye360","lm6a-yaogan50-03","lm4b-jiuquan","lm8a-wenchang"]):
    a=ax[i]; a.plot(*rd(f"{R}/{s}/{trajectory_basename(s, DATES[s]+'T00:00:00Z')}"),"--",label="surrogate (event-based)")
    a.plot(*rd(f"/tmp/out_before/{s}/{s}_ascent_ecef_5s_sim.csv"),":",c="gray",label="3DOF sim, before tuning")
    a.plot(*rd(f"out/{s}/{s}_ascent_ecef_5s_sim.csv"),label="3DOF sim, tuned")
    if s=="lm4b-jiuquan":
        for t in (153.059,198.558,282.494,293.294,648.684): a.axvline(t,c="k",lw=.5)
        a.text(5,450,"black lines = published Y51 event times",fontsize=8)
    a.set_title(s); a.set_xlabel("T+ s"); a.set_ylabel("altitude km"); a.grid(); a.legend(fontsize=8)
L=json.load(open("launches/lm3b-calt-validation.json")); K=L["knots"]
a=ax[4]; a.plot(*rd("/tmp/out_before/lm3b-calt-validation/lm3b-calt-validation_ascent_ecef_5s_sim.csv"),":",c="gray",label="sim before (pad alt 0)")
a.plot(*rd("out/lm3b-calt-validation/lm3b-calt-validation_ascent_ecef_5s_sim.csv"),label="sim tuned")
a.plot([k["t_s"] for k in K],[k["alt_km"] for k in K],"ko",label="CALT manual T3-5/3-6")
a.set_title("LM-3B validation vs CALT manual"); a.grid(); a.legend(fontsize=8); a.set_xlabel("T+ s")
a=ax[5]; tab=L["fitted"]["knot_residuals"]
a.bar(range(len(tab)),[r["alt_sim"]-r["alt_pub"] for r in tab],label="altitude (km)")
a.plot(range(len(tab)),[(r["rng_sim"]-r["rng_pub"])/2 for r in tab],"rs",label="ground range /2 (km)")
a.set_xticks(range(len(tab))); a.set_xticklabels([r["event"] for r in tab],rotation=60,ha="right",fontsize=7); a.axhline(0,c="k"); a.grid(); a.legend(fontsize=8)
a.set_title("LM-3B tuned residuals at manual events (times exact)")
fig.suptitle("ILLUSTRATIVE — tuned 3DOF sim vs surrogate and pre-tuning sim"); fig.tight_layout(); fig.savefig("altitude_compare.png",dpi=90)
