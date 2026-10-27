"""Timeline (burn-time-driven) mode for ascent3dof + least-squares fit of free parameters to published event knots.
Used when vehicles/<id>.json has "timeline": true. Every ignition/cutoff/separation/fairing time is a HARD event
taken from a published sequence; mdot = F_vac/(Isp_vac*g0); burned propellant = mdot*burn time; the published
propellant load minus burned propellant is carried as residual/reserve (flagged when negative).
"""
import math, numpy as np
from scipy.optimize import least_squares
from ascent3dof import (val, geod2ecef, ecef2geod, enu, rotz, atmos, grav, A, E2, MU, WE, G0, P0)

def gc_km(a1, b1, a2, b2):
    a1, b1, a2, b2 = map(math.radians, (a1, b1, a2, b2))
    return 6371.0088*2*math.asin(math.sqrt(math.sin((a2-a1)/2)**2+math.cos(a1)*math.cos(a2)*math.sin((b2-b1)/2)**2))

class TStage:
    def __init__(s, d, final_cutoff=None):
        s.name = d["name"]; s.n = int(val(d.get("count", 1))); s.parallel = d.get("parallel", False)
        Fv = val(d["thrust_vac_N"])*s.n; Fs = val(d.get("thrust_sl_N", d["thrust_vac_N"]))*s.n; Iv = val(d["isp_vac_s"])
        s.Fv, s.Fs = Fv, Fs; s.Ae = (Fv-Fs)/P0; s.mdot = Fv/(Iv*G0)
        s.t_ign = val(d["ignition_s"]); s.t_cut = val(d["cutoff_s"]) if final_cutoff is None else final_cutoff
        s.t_sep = val(d["separation_s"]) if "separation_s" in d else None
        s.diam = val(d["diameter_m"]); s.dry = val(d["dry_kg"])*s.n
        tl = d.get("tail")  # e.g. verniers running alone after main-engine cutoff
        s.tail = None
        if tl: s.tail = dict(F=val(tl["thrust_vac_N"])*s.n, mdot=val(tl["thrust_vac_N"])*s.n/(val(tl["isp_vac_s"])*G0),
                             t_cut=val(tl["cutoff_s"]), vern_with_main=tl.get("runs_with_main", True))
        burn_main = s.mdot*(s.t_cut-s.t_ign)
        burn_tail = 0.
        if s.tail: burn_tail = s.tail["mdot"]*((s.tail["t_cut"]-s.t_ign) if s.tail["vern_with_main"] else (s.tail["t_cut"]-s.t_cut))
        s.burned = burn_main+burn_tail
        pub = val(d["propellant_kg"])*s.n if "propellant_kg" in d else None
        s.loaded = pub if (pub is not None and pub >= s.burned) else s.burned
        s.flag = None if pub is None or pub >= s.burned else f"published load {pub:.0f} kg < burned {s.burned:.0f} kg; load raised to burned"
        s.residual = s.loaded-s.burned
    def thrust_mdot(s, t, P):
        F = 0.; md = 0.
        if s.t_ign <= t < s.t_cut: F += max(s.Fv-s.Ae*P, 0); md += s.mdot
        if s.tail and s.t_ign <= t < s.tail["t_cut"] and (t >= s.t_cut or s.tail["vern_with_main"]): F += s.tail["F"]; md += s.tail["mdot"]
        return F, md
    def end(s): return max(s.t_cut, s.tail["t_cut"] if s.tail else 0)

class TimedSim:
    PNAMES = ["vertical_rise_s", "kick_deg", "cd", "payload_kg", "tan0", "tan_rate"]
    def __init__(s, V, L):
        s.V, s.L = V, L
        fc = val(L["final_cutoff_s"]) if "final_cutoff_s" in L else None
        stages = [dict(d) for d in V["stages"]]   # per-launch published event times override the vehicle defaults
        for k, ov in (L.get("stage_event_overrides") or {}).items(): stages[int(k)].update(ov)
        s.st = [TStage(d, fc if i == len(stages)-1 else None) for i, d in enumerate(stages)]
        s.fairing = val(V["fairing"]["mass_kg"]); s.fair_t = val(L.get("fairing_jettison_s", V["fairing"]["jettison_time_s"]))
        s.lat0, s.lon0, s.h0 = L["pad"]["lat"], L["pad"]["lon"], val(L["pad"].get("alt_m", 0))
        s.az = math.radians(val(L["azimuth_deg"])); tg = L["target"]
        s.h_t = val(tg["insertion_alt_km"])*1e3; s.ha_t = val(tg.get("apoapsis_alt_km", tg["insertion_alt_km"]))*1e3
        s.a_t = (2*A+s.h_t+s.ha_t)/2; s.a_sig = val(tg.get("sma_sigma_km", 5))*1e3
        g = V["guidance"]; s.t_kick = val(g["kick_duration_s"]); s.lt_from = g.get("linear_tangent_from_stage", 2)
        s.fit = V["fit"]; s.fixed = {k: val(v) for k, v in V.get("fixed_params", {}).items()}
        if not (isinstance(L.get("payload_kg"), dict) and L["payload_kg"].get("fit")): s.fixed["payload_kg"] = val(L["payload_kg"])
        s.knots = L.get("knots", [])
        s.free = [p for p in s.PNAMES if p not in s.fixed]
        s.cd = s.fixed.get("cd"); s.payload = None; s.t_vert = None
    def params(s, x): p = dict(s.fixed); p.update(dict(zip(s.free, x))); return p
    def run(s, x, record=False, dt_=0.5):
        p = s.params(x); s.payload = p["payload_kg"]; s.cd = p["cd"]; s.t_vert = p["vertical_rise_s"]
        kick = math.radians(p["kick_deg"]); tan0, tanr = p["tan0"], p["tan_rate"]
        r = geod2ecef(s.lat0, s.lon0, s.h0); w = np.array([0, 0, WE]); v = np.cross(w, r)
        e, n, u = enu(s.lat0, s.lon0); d0 = math.sin(s.az)*e+math.cos(s.az)*n; hvec = np.cross(r, d0); hvec /= np.linalg.norm(hvec)
        prop = [st.loaded for st in s.st]; att = [True]*len(s.st); fair = True
        t_lt = s.st[s.lt_from].t_ign; t_end = s.st[-1].end()
        evts = []
        for i, st in enumerate(s.st):
            evts += [(st.t_ign, f"{st.name} ignition", None), (st.t_cut, f"{st.name} cutoff", None)]
            if st.tail: evts.append((st.tail["t_cut"], f"{st.name} vernier cutoff", None))
            if st.t_sep is not None: evts.append((st.t_sep, f"{st.name} separation", ("sep", i)))
        evts.append((s.fair_t, "Fairing jettison", ("fair",)))
        evts += [(s.t_vert, "Pitch-over start", None), (s.t_vert+s.t_kick, "Pitch kick end", None)]
        evts = sorted([e_ for e_ in evts if 0 < e_[0] <= t_end+1e-9], key=lambda z: z[0])
        mass = lambda: s.payload+(s.fairing if fair else 0)+sum(st.dry+prop[i] for i, st in enumerate(s.st) if att[i])
        diam = max(st.diam for st in s.st)
        t = 0.; ev = [s._state("Liftoff", t, r, v, mass())]; rows = []; k = 0
        def acc(tt, rr, vv, m):
            hh = np.linalg.norm(rr)-A*(1-E2*0.5*(rr[2]/np.linalg.norm(rr))**2)
            rho, P = atmos(hh); vrel = vv-np.cross(w, rr); vr = np.linalg.norm(vrel)
            a = grav(rr)-(0.5*rho*vr*vrel*s.cd*math.pi*diam**2/4/m if vr > 0 else 0)
            F = sum(st.thrust_mdot(tt, P)[0] for i, st in enumerate(s.st) if att[i])
            if F > 0:
                ur = rr/np.linalg.norm(rr); hz = np.cross(hvec, ur); hz /= np.linalg.norm(hz)
                if tt < s.t_vert: dirn = ur
                elif tt < s.t_vert+s.t_kick: th = kick*(tt-s.t_vert)/s.t_kick; dirn = math.cos(th)*ur+math.sin(th)*hz
                elif tt < t_lt: dirn = vrel/vr
                else: th = math.atan(tan0-tanr*(tt-t_lt)); dirn = math.cos(th)*hz+math.sin(th)*ur
                a = a+F/m*dirn
            return a
        while t < t_end-1e-9:
            if record and abs(t/5-round(t/5)) < 1e-6: rows.append((t, r.copy(), v.copy()))
            nxt = min([e_[0] for e_ in evts[k:]]+[t_end, (math.floor(t/5+1e-9)+1)*5 if record else 1e9])
            h = min(dt_, nxt-t); m = mass(); tm = t+h/2
            k1v = acc(t, r, v, m); k1r = v
            k2v = acc(tm, r+k1r*h/2, v+k1v*h/2, m); k2r = v+k1v*h/2
            k3v = acc(tm, r+k2r*h/2, v+k2v*h/2, m); k3r = v+k2v*h/2
            k4v = acc(t+h-1e-9, r+k3r*h, v+k3v*h, m); k4r = v+k3v*h
            r = r+h/6*(k1r+2*k2r+2*k3r+k4r); v = v+h/6*(k1v+2*k2v+2*k3v+k4v)
            for i, st in enumerate(s.st):
                if att[i]: prop[i] -= st.thrust_mdot(tm, 0)[1]*h
            t += h
            if np.linalg.norm(r) < A*0.99: return None, None, ev
            while k < len(evts) and evts[k][0] <= t+1e-9:
                _, nm, act = evts[k]; k += 1
                if act and act[0] == "sep": att[act[1]] = False
                if act and act[0] == "fair": fair = False
                ev.append(s._state(nm, t, r, v, mass()))
        ev.append(s._state("Insertion (final cutoff)", t, r, v, mass()))
        if record: rows.append((t, r.copy(), v.copy()))
        return (t, r, v), rows, ev
    def _state(s, name, t, r, v, m):
        lat, lon, h = ecef2geod(rotz(-WE*t)@r); vrel = v-np.cross([0, 0, WE], r); rn = np.linalg.norm(r)
        fpa = math.degrees(math.asin(np.dot(r, v)/rn/np.linalg.norm(v)))
        return dict(event=name, t_s=round(t, 3), alt_km=round(h/1e3, 2), range_km=round(gc_km(s.lat0, s.lon0, lat, lon), 1),
                    v_inertial_km_s=round(float(np.linalg.norm(v))/1e3, 4), v_rel_km_s=round(float(np.linalg.norm(vrel))/1e3, 4),
                    fpa_inertial_deg=round(fpa, 3), mass_kg=round(m, 1), lat=round(lat, 4), lon=round(lon, 4))
    def residuals(s, x, detail=False):
        end, _, ev = s.run(x)
        if end is None: return np.full(2*len(s.knots)+3, 1e3)
        t, r, v = end; rn = np.linalg.norm(r); h = ecef2geod(rotz(-WE*t)@r)[2]
        fpa = math.degrees(math.asin(np.dot(r, v)/rn/np.linalg.norm(v))); en = np.dot(v, v)/2-MU/rn; a = -MU/(2*en) if en < 0 else 1e8
        res = []; tab = []
        for kn in s.knots:
            e_ = min(ev, key=lambda z: abs(z["t_s"]-kn["t_s"]))
            ra = (e_["alt_km"]-kn["alt_km"])/kn.get("alt_sigma_km", 1.0); res.append(ra)
            rr = (e_["range_km"]-kn["range_km"])/kn.get("range_sigma_km", 5.0) if "range_km" in kn else 0.; res.append(rr)
            tab.append(dict(event=kn["event"], t_pub=kn["t_s"], t_sim=e_["t_s"], alt_pub=kn["alt_km"], alt_sim=e_["alt_km"],
                            rng_pub=kn.get("range_km"), rng_sim=e_["range_km"]))
        res += [(h-s.h_t)/1e3, fpa/0.05, (a-s.a_t)/s.a_sig]
        if detail: return np.array(res), tab, dict(alt_km=h/1e3, fpa_deg=fpa, sma_err_km=(a-s.a_t)/1e3, mass_kg=ev[-1]["mass_kg"])
        return np.array(res)
    def solve(s):
        x0 = np.array([val(s.fit[p]["x0"]) for p in s.free]); lo = [s.fit[p]["bounds"][0] for p in s.free]; hi = [s.fit[p]["bounds"][1] for p in s.free]
        sc = np.array([max(abs(b-a_), 1e-6) for a_, b in zip(lo, hi)])
        best = None
        for tan0 in ([x0[s.free.index("tan0")]] + [0.2, 0.6] if "tan0" in s.free else [None]):
            xs = x0.copy()
            if tan0 is not None: xs[s.free.index("tan0")] = tan0
            rsl = least_squares(s.residuals, xs, bounds=(lo, hi), x_scale=sc, diff_step=1e-3, max_nfev=200)
            if best is None or rsl.cost < best.cost: best = rsl
        return best.x, best.cost
    def mass_budget(s):
        return dict(stages=[dict(name=st.name, loaded_kg=round(st.loaded), burned_kg=round(st.burned), residual_kg=round(st.residual),
                                 dry_kg=st.dry, flag=st.flag) for st in s.st],
                    glow_kg=round(sum(st.dry+st.loaded for st in s.st)+s.fairing+(s.payload or 0)))
