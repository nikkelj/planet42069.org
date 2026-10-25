#!/usr/bin/env python3
"""Extend a 3DOF ascent sim past final upper-stage cutoff through PAYLOAD DEPLOY (ILLUSTRATIVE).
Reads out/<slug>/<slug>_ascent_ecef_5s_sim.csv (as written by ascent3dof.py), takes the final-cutoff state, and
propagates with the SAME model (WGS-84 rotating Earth, J2, US76 drag) through any published restart / kick-stage
burns to the provider's published deploy time. Config: launches/<slug>.json -> "post_cutoff" (every number sourced,
derived or ASSUMPTION). Without a published deploy time (deploy.t_s null) the
stage is propagated from insertion for TWO revolutions (osculating period at insertion) on the inferred insertion
orbit, ending labelled 'inferred insertion orbit, +2 revs (deploy time unpublished)'. Idempotent: strips any previous coast rows first.
Usage: python3 deploy_coast.py launches/<slug>.json [--outdir DIR]
"""
import json, math, os, sys, argparse, datetime as dt
import numpy as np
from ascent3dof import A, MU, WE, G0, val, ecef2geod, rotz, atmos, grav, write_kml

W = np.array([0, 0, WE])

def kep(r, v):
    rn = np.linalg.norm(r); en = v @ v/2-MU/rn; a = -MU/(2*en); h = np.cross(r, v)
    e = math.sqrt(max(0, 1-(h @ h)/(MU*a))); i = math.degrees(math.acos(h[2]/np.linalg.norm(h)))
    return a, e, i, (a*(1-e)-A)/1e3, (a*(1+e)-A)/1e3

def propagate(r, v, m, t0, t1, cfg, burn=None, record=None, grid=5.0, dt_=1.0):
    """RK4 in ECI. burn=(F_N, isp_s) prograde (inertial velocity) for the whole interval. Rows on the 5 s grid."""
    cda = val(cfg["drag"]["cd"])*val(cfg["drag"]["area_m2"]); t = t0
    def acc(rr, vv, mm):
        h = np.linalg.norm(rr)-A*(1-0.5*0.00669438*(rr[2]/np.linalg.norm(rr))**2)
        rho, _ = atmos(h); vrel = vv-np.cross(W, rr); vr = np.linalg.norm(vrel)
        a = grav(rr)-0.5*rho*vr*vrel*cda/mm
        if burn: a = a+burn[0]/mm*vv/np.linalg.norm(vv)
        return a
    mdot = burn[0]/(burn[1]*G0) if burn else 0.
    while t < t1-1e-9:
        nxt = min(t1, (math.floor(t/grid+1e-9)+1)*grid); h = min(dt_, nxt-t)
        k1v = acc(r, v, m); k1r = v
        k2v = acc(r+k1r*h/2, v+k1v*h/2, m-mdot*h/2); k2r = v+k1v*h/2
        k3v = acc(r+k2r*h/2, v+k2v*h/2, m-mdot*h/2); k3r = v+k2v*h/2
        k4v = acc(r+k3r*h, v+k3v*h, m-mdot*h); k4r = v+k3v*h
        r = r+h/6*(k1r+2*k2r+2*k3r+k4r); v = v+h/6*(k1v+2*k2v+2*k3v+k4v); m -= mdot*h; t += h
        if record is not None and (abs(t/grid-round(t/grid)) < 1e-6 or abs(t-t1) < 1e-9): record.append((t, r.copy(), v.copy(), "burn" if burn else "coast"))
    return r, v, m

def apo_time(r, v, m, t0, cfg):
    """time of next apoapsis (coast), by stepping until radial velocity changes sign."""
    t = t0; rr, vv = r.copy(), v.copy()
    while True:
        r2, v2, _ = propagate(rr, vv, m, t, t+10, cfg, dt_=2.0)
        if rr @ vv > 0 and r2 @ v2 <= 0:  # bisect inside the 10 s step
            lo, hi = t, t+10
            for _ in range(20):
                md = (lo+hi)/2; r3, v3, _ = propagate(r, v, m, t0, md, cfg, dt_=1.0)
                lo, hi = (md, hi) if r3 @ v3 > 0 else (lo, md)
            return (lo+hi)/2
        rr, vv, t = r2, v2, t+10
        if t-t0 > 20000: raise RuntimeError("no apoapsis")

def solve_burn(r, v, m, t_ign, b, cfg):
    """returns (F, duration). Either duration fixed & thrust solved, or thrust fixed & duration solved, to hit target perigee."""
    tgt = val(b["target_perigee_km"]); isp = val(b["isp_s"])
    def perigee(F, d):
        r2, v2, _ = propagate(r, v, m, t_ign, t_ign+d, cfg, burn=(F, isp), dt_=0.25); return kep(r2, v2)[3]
    if b.get("duration_s") is not None:
        d = val(b["duration_s"]); lo, hi = 0., 5e6
        for _ in range(60):
            md = (lo+hi)/2; lo, hi = (md, hi) if perigee(md, d) < tgt else (lo, md)
        return (lo+hi)/2, d
    F = val(b["thrust_N"]); lo, hi = 0., 3000.
    for _ in range(40):
        md = (lo+hi)/2; lo, hi = (md, hi) if perigee(F, md) < tgt else (lo, md)
    return F, (lo+hi)/2

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("launch"); ap.add_argument("--outdir"); a = ap.parse_args()
    here = os.path.dirname(os.path.abspath(__file__)); L = json.load(open(a.launch)); slug = L["slug"]
    od = a.outdir or os.path.join(here, "out", slug); fn = os.path.join(od, f"{slug}_ascent_ecef_5s_sim.csv")
    evf = os.path.join(od, f"{slug}_events_sim.json"); EV = json.load(open(evf))
    EV["events"] = [e for e in EV["events"] if not e.get("post_cutoff")]
    lines = open(fn).read().splitlines()
    hdr = [l for l in lines if l.startswith("#") and not l.startswith("# POST-CUTOFF")]
    col = [l for l in lines if l.startswith("elapsed_s")][0]
    data = [l for l in lines if l and not l.startswith("#") and not l.startswith("elapsed_s") and ",coast" not in l.split(",")[-1] and not l.endswith("-coast") and not l.endswith("-burn")]
    last = data[-1].split(","); src = last[-1]; t_cut = float(last[0])
    re = np.array([float(x) for x in last[6:9]])*1e3; ve = np.array([float(x) for x in last[9:12]])*1e3
    R = rotz(WE*t_cut); r = R@re; v = R@(ve+np.cross(W, re))
    m = EV["events"][-1]["mass_kg"]; pc = L.get("post_cutoff"); T0 = dt.datetime.strptime(L["t0_utc"], "%Y-%m-%dT%H:%M:%SZ")
    note = []; rec = []; new_ev = []
    def st(name, t, rr, vv, mm, **kw):
        lat, lon, h = ecef2geod(rotz(-WE*t)@rr); a_, e_, i_, hp, ha = kep(rr, vv)
        d = dict(event=name, t_s=round(t, 3), alt_km=round(h/1e3, 2), v_inertial_km_s=round(float(np.linalg.norm(vv))/1e3, 4), mass_kg=round(mm, 1),
                 lat=round(lat, 4), lon=round(lon, 4), perigee_km=round(hp, 1), apogee_km=round(ha, 1), incl_deg=round(i_, 3), post_cutoff=True); d.update(kw); return d
    if not pc or pc.get("deploy", {}).get("t_s") is None:
        why = (pc or {}).get("deploy", {}).get("note", "provider has not published a payload-deploy time")
        new_ev.append(st("Orbit insertion (inferred insertion orbit)", t_cut, r, v, m, note=why))
        a0 = kep(r, v)[0]; P = 2*math.pi*math.sqrt(a0**3/MU); tend = t_cut+2*P
        r, v, m = propagate(r, v, m, t_cut, tend, pc or {"drag": {"cd": 2.2, "area_m2": 4.0}}, record=rec)
        new_ev.append(st("End: inferred insertion orbit, +2 revs (deploy time unpublished)", tend, r, v, m, note=why))
        e = new_ev[-1]
        note.append(f"# POST-CUTOFF: deploy time unpublished ({why}). From insertion T+{t_cut:.1f} s the stage is propagated for TWO revolutions (osculating period {P/60:.2f} min) on the inferred insertion orbit (same WGS-84/J2/US76-drag model); rows tagged -coast.")
        note.append(f"# POST-CUTOFF end T+{tend:.0f} s: inferred insertion orbit, +2 revs (deploy time unpublished): alt {e['alt_km']} km, osculating {e['perigee_km']} x {e['apogee_km']} km, i {e['incl_deg']} deg.")
        for n in (pc or {}).get("notes", []): note.append("# POST-CUTOFF note: "+n)
    else:
        t = t_cut
        for b in pc.get("burns", []):
            t_ign = apo_time(r, v, m, t, pc) if b["t_ign_s"] == "apoapsis" else val(b["t_ign_s"])
            m_b = m-val(b.get("drop_mass_kg", 0)) if not b.get("mass_after_drop_kg") else val(b["mass_after_drop_kg"])
            if b.get("center_on_apoapsis"):
                ra, va, _ = propagate(r, v, m, t, t_ign, pc); _, d0 = solve_burn(ra, va, m_b, t_ign, b, pc)
                t_ign -= d0/2
            r, v, m = propagate(r, v, m, t, t_ign, pc, record=rec); t = t_ign; m = m_b
            F, d = solve_burn(r, v, m, t_ign, b, pc)
            new_ev.append(st(f"{b['name']} ignition", t, r, v, m))
            r, v, m = propagate(r, v, m, t, t+d, pc, burn=(F, val(b["isp_s"])), record=rec, dt_=0.25); t += d
            new_ev.append(st(f"{b['name']} cutoff", t, r, v, m, modelled_thrust_N=round(F, 1), burn_s=round(d, 2)))
            note.append(f"# POST-CUTOFF burn '{b['name']}': ign T+{new_ev[-2]['t_s']:.1f} s, {d:.1f} s at {F/1e3:.2f} kN prograde (Isp {val(b['isp_s'])} s); {b['basis']}")
        td = t if pc["deploy"]["t_s"] == "after_last_burn" else val(pc["deploy"]["t_s"]); r, v, m = propagate(r, v, m, t, td, pc, record=rec); t = td
        new_ev.append(st(pc["deploy"].get("label", "Payload deploy"), t, r, v, m, src=pc["deploy"]["src"]))
        e = new_ev[-1]
        note.insert(0, f"# POST-CUTOFF: after final cutoff T+{t_cut:.1f} s the stage coasts (same WGS-84/J2/US76-drag model) to PAYLOAD DEPLOY T+{td:.0f} s; rows after cutoff tagged -coast/-burn.")
        note.append(f"# POST-CUTOFF deploy T+{td:.0f} s ({pc['deploy']['src']}): alt {e['alt_km']} km, osculating {e['perigee_km']} x {e['apogee_km']} km, i {e['incl_deg']} deg.")
        for n in pc.get("notes", []): note.append("# POST-CUTOFF note: "+n)
    # rewrite CSV
    rng = float(last[5]); prev = (float(last[2]), float(last[3])); out = []
    for t, rr, vv, ph in rec:
        if t <= t_cut+1e-9: continue
        Rm = rotz(-WE*t); re_ = Rm@rr; ve_ = Rm@(vv-np.cross(W, rr)); lat, lon, h = ecef2geod(re_)
        a1, b1 = map(math.radians, prev); a2, b2 = math.radians(lat), math.radians(lon)
        rng += 6371.0088*2*math.asin(math.sqrt(math.sin((a2-a1)/2)**2+math.cos(a1)*math.cos(a2)*math.sin((b2-b1)/2)**2)); prev = (lat, lon)
        utc = (T0+dt.timedelta(seconds=float(t))).strftime("%Y-%m-%dT%H:%M:%SZ")
        out.append(f"{t:.3f},{utc},{lat:.7f},{lon:.7f},{h/1e3:.3f},{rng:.3f},{re_[0]/1e3:.6f},{re_[1]/1e3:.6f},{re_[2]/1e3:.6f},{ve_[0]/1e3:.6f},{ve_[1]/1e3:.6f},{ve_[2]/1e3:.6f},{np.linalg.norm(ve_)/1e3:.6f},{src}-{ph}")
    hdr = [h for h in hdr if "File ends at" not in h and "Kick Stage circularization not simulated" not in h]
    open(fn, "w").write("\n".join(hdr+note+[col]+data+out)+"\n")
    EV["events"] += new_ev; EV["post_cutoff"] = pc; json.dump(EV, open(evf, "w"), indent=1)
    kml = os.path.join(od, f"{slug}_ascent_sim.kml"); write_kml(fn, kml, slug)
    k = open(kml).read(); e = new_ev[-1]
    pm = "".join(f"<Placemark><name>{x['event']} T+{x['t_s']:.0f}s (ILLUSTRATIVE)</name><description>alt {x['alt_km']} km, osculating {x['perigee_km']} x {x['apogee_km']} km, i {x['incl_deg']} deg{'; '+x.get('src','') if x.get('src') else ''}{'; '+x.get('note','') if x.get('note') else ''}</description><Point><altitudeMode>absolute</altitudeMode><coordinates>{x['lon']},{x['lat']},{x['alt_km']*1000:.0f}</coordinates></Point></Placemark>" for x in new_ev)
    open(kml, "w").write(k.replace("</Document>", f"<Folder><name>Post-cutoff events (ILLUSTRATIVE)</name>{pm}</Folder></Document>"))
    print(slug, "cutoff", t_cut); [print("  ", x) for x in new_ev]

if __name__ == "__main__": main()
