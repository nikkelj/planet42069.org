#!/usr/bin/env python3
"""First-principles 3-DOF launch ascent simulator (point mass, rotating WGS-84 Earth, J2, US76 drag).
ILLUSTRATIVE: OSINT vehicle numbers + labelled assumptions; NOT telemetry.
Usage: python3 ascent3dof.py launches/<slug>.json [--outdir DIR]
"""
import json, math, sys, os, argparse, datetime as dt
import numpy as np
from scipy.optimize import minimize
A=6378137.0; F=1/298.257223563; E2=F*(2-F); MU=3.986004418e14; J2=1.08262668e-3; WE=7.2921159e-5; G0=9.80665; P0=101325.0

def val(x):  # config values are {"value":..,"src"|"derived"|"assumption":..} or plain numbers
    return x["value"] if isinstance(x,dict) else x

# ---------- geodesy ----------
def geod2ecef(lat,lon,h):
    la,lo=math.radians(lat),math.radians(lon); N=A/math.sqrt(1-E2*math.sin(la)**2)
    return np.array([(N+h)*math.cos(la)*math.cos(lo),(N+h)*math.cos(la)*math.sin(lo),(N*(1-E2)+h)*math.sin(la)])
def ecef2geod(r):
    x,y,z=r; lon=math.atan2(y,x); p=math.hypot(x,y); lat=math.atan2(z,p*(1-E2))
    for _ in range(6):
        N=A/math.sqrt(1-E2*math.sin(lat)**2); h=p/math.cos(lat)-N; lat=math.atan2(z,p*(1-E2*N/(N+h)))
    N=A/math.sqrt(1-E2*math.sin(lat)**2); h=p/math.cos(lat)-N
    return math.degrees(lat),math.degrees(lon),h
def enu(lat,lon):
    la,lo=math.radians(lat),math.radians(lon)
    return (np.array([-math.sin(lo),math.cos(lo),0.]),
            np.array([-math.sin(la)*math.cos(lo),-math.sin(la)*math.sin(lo),math.cos(la)]),
            np.array([math.cos(la)*math.cos(lo),math.cos(la)*math.sin(lo),math.sin(la)]))
def rotz(th):
    c,s=math.cos(th),math.sin(th); return np.array([[c,-s,0],[s,c,0],[0,0,1.]])

# ---------- environment ----------
_US76=[(0,288.15,-0.0065,101325.0),(11000,216.65,0.0,22632.06),(20000,216.65,0.001,5474.889),(32000,228.65,0.0028,868.0187),
       (47000,270.65,0.0,110.9063),(51000,270.65,-0.0028,66.93887),(71000,214.65,-0.002,3.956420),(84852,186.946,0.0,0.3734)]
def atmos(h):
    """US Standard Atmosphere 1976 (geopotential layers to 84.852 km), exponential tail above (H from 86-150 km US76 densities)."""
    if h<0: h=0.
    hg=6356766*h/(6356766+h); R=287.053
    if hg<84852:
        for i in range(len(_US76)-1,-1,-1):
            if hg>=_US76[i][0]: b,Tb,L,Pb=_US76[i]; break
        T=Tb+L*(hg-b); P=Pb*(T/Tb)**(-G0/(R*L)) if L!=0 else Pb*math.exp(-G0*(hg-b)/(R*Tb))
        return P/(R*T),P
    rho=6.958e-6*math.exp(-(h-86000)/6300.0) if h<150000 else 2.076e-9*math.exp(-(h-150000)/22000.0)
    P=0.3734*math.exp(-(h-86000)/5800.0); return rho,P
def grav(r):
    x,y,z=r; rn=np.linalg.norm(r); k=1.5*J2*MU*A**2/rn**5; zz=5*z*z/rn**2
    return -MU*r/rn**3+k*np.array([x*(zz-1),y*(zz-1),z*(zz-3)])

# ---------- vehicle ----------
class Stage:
    def __init__(s,d):
        s.name=d["name"]; s.n=int(val(d.get("count",1))); s.prop=val(d["propellant_kg"])*s.n; s.dry=val(d["dry_kg"])*s.n
        Fv=val(d["thrust_vac_N"]); Fs=val(d.get("thrust_sl_N",d["thrust_vac_N"])); Iv=val(d["isp_vac_s"])
        s.Fv=Fv*s.n; s.Fs=Fs*s.n; s.mdot=s.Fv/(Iv*G0)
        if "burn_time_s" in d and d.get("mdot_from_burn_time",False):   # effective average thrust from published prop & burn time
            s.mdot=s.prop/val(d["burn_time_s"]); sc=s.mdot*Iv*G0/s.Fv; s.Fv*=sc; s.Fs*=sc
        s.Ae=(s.Fv-s.Fs)/P0; s.diam=val(d["diameter_m"]); s.parallel=d.get("parallel",False)
        s.coast_before=val(d.get("coast_before_s",0)); s.max_burn=val(d["max_burn_s"]) if "max_burn_s" in d else None
    def thrust(s,P): return max(s.Fv-s.Ae*P,0.)

class Sim:
    def __init__(s,veh,launch):
        s.V=veh; s.L=launch; s.st=[Stage(d) for d in veh["stages"]]
        s.payload=val(launch["payload_kg"]); s.fairing=val(veh["fairing"]["mass_kg"])
        s.fair_t=val(veh["fairing"].get("jettison_time_s")) if veh["fairing"].get("jettison_time_s") is not None else None
        s.fair_h=val(veh["fairing"].get("jettison_alt_km",110))*1e3; s.cd=val(veh.get("cd",0.4))
        g=veh["guidance"]; s.t_vert0=val(g.get("vertical_rise_s",0)); s.v_vert=val(g.get("vertical_rise_until_vrel_mps",0)); s.t_vert=s.t_vert0; s.t_kick=val(g.get("kick_duration_s",10))
        s.lat0,s.lon0,s.h0=launch["pad"]["lat"],launch["pad"]["lon"],launch["pad"].get("alt_m",0)
        s.az=math.radians(val(launch["azimuth_deg"]))
        tg=launch["target"]; s.h_t=val(tg["insertion_alt_km"])*1e3; s.ha_t=val(tg.get("apoapsis_alt_km",tg["insertion_alt_km"]))*1e3
        s.R_t=A+s.h_t; s.a_t=(s.R_t+A+s.ha_t)/2; s.cutoff=tg.get("cutoff","energy")
        s.lt_from=g.get("linear_tangent_from_stage",1)  # index of the stack element where closed-loop steering starts
    def run(s,x,record=False,dt_=0.5):
        kick,tan0,tanr=x; kick=math.radians(kick)
        r=geod2ecef(s.lat0,s.lon0,s.h0); w=np.array([0,0,WE]); v=np.cross(w,r)  # ECI == ECEF at T0
        e,n,u=enu(s.lat0,s.lon0); d0=math.sin(s.az)*e+math.cos(s.az)*n; hvec=np.cross(r,d0); hvec/=np.linalg.norm(hvec)
        # mission sequence: parallel boosters burn with first core stage
        seq=[]; i=0
        while i<len(s.st):
            grp=[s.st[i]]
            if s.st[i].parallel: grp.append(s.st[i+1]); i+=1
            seq.append(grp); i+=1
        prop={id(st):st.prop for st in s.st}; attached=set(id(st) for st in s.st); fair=True
        t=0.; ev=[]; rows=[]; gi=0; t_ign=0.; lt_t0=None; done=False; diam=max(st.diam for st in s.st)
        def mass():
            return s.payload+(s.fairing if fair else 0)+sum(st.dry+prop[id(st)] for st in s.st if id(st) in attached)
        def log(name):
            ev.append(s._state(name,t,r,v,mass()))
        s.t_vert=s.t_vert0 if s.v_vert<=0 else 1e9
        log("Liftoff"); coast_until=0; pend_ign=None
        while not done and t<3000:
            grp=[st for st in seq[gi] if id(st) in attached]
            burning=t>=coast_until-1e-9
            if burning and pend_ign: log(f"{pend_ign} ignition"); pend_ign=None
            ecef_r=rotz(-WE*t)@r; lat,lon,h=ecef2geod(ecef_r)
            if record and abs(t/5-round(t/5))<1e-6: rows.append((t,r.copy(),v.copy()))
            def acc(rr,vv,m):
                hh=np.linalg.norm(rr)-A*(1-E2*0.5*(rr[2]/np.linalg.norm(rr))**2)  # approx geodetic alt for env
                rho,P=atmos(hh); vrel=vv-np.cross(w,rr); vr=np.linalg.norm(vrel)
                a=grav(rr)-(0.5*rho*vr*vrel*s.cd*math.pi*diam**2/4/m if vr>0 else 0)
                if burning:
                    Fth=sum(st.thrust(P) for st in grp if prop[id(st)]>0)
                    ur=rr/np.linalg.norm(rr)
                    if t<s.t_vert: dirn=ur
                    elif t<s.t_vert+s.t_kick:
                        th=kick*(t-s.t_vert)/s.t_kick; hz=np.cross(hvec,ur); hz/=np.linalg.norm(hz); dirn=math.cos(th)*ur+math.sin(th)*hz
                    elif lt_t0 is None: dirn=vrel/vr
                    else:
                        hz=np.cross(hvec,ur); hz/=np.linalg.norm(hz); th=math.atan(tan0-tanr*(t-lt_t0)); dirn=math.cos(th)*hz+math.sin(th)*ur
                    a=a+Fth/m*dirn
                return a
            if s.t_vert>1e8 and np.linalg.norm(v-np.cross(w,r))>=s.v_vert: s.t_vert=t; log("Pitch-over start")
            m=mass()
            k1v=acc(r,v,m); k1r=v
            k2v=acc(r+k1r*dt_/2,v+k1v*dt_/2,m); k2r=v+k1v*dt_/2
            k3v=acc(r+k2r*dt_/2,v+k2v*dt_/2,m); k3r=v+k2v*dt_/2
            k4v=acc(r+k3r*dt_,v+k3v*dt_,m); k4r=v+k3v*dt_
            r=r+dt_/6*(k1r+2*k2r+2*k3r+k4r); v=v+dt_/6*(k1v+2*k2v+2*k3v+k4v); t+=dt_
            if burning:
                for st in grp:
                    if prop[id(st)]>0: prop[id(st)]-=st.mdot*dt_
            if np.linalg.norm(r)<A*0.99 or ecef2geod(rotz(-WE*t)@r)[2]<-100: log("CRASH"); return None,None,ev
            hgt=ecef2geod(rotz(-WE*t)@r)[2]
            if fair and ((s.fair_t is not None and t>=s.fair_t) or (s.fair_t is None and hgt>=s.fair_h)): fair=False; log("Fairing jettison")
            # cutoff test for final stage
            last=gi==len(seq)-1
            en=np.dot(v,v)/2-MU/np.linalg.norm(r); a_sma=-MU/(2*en) if en<0 else 1e12
            if last and burning and s.cutoff=="energy" and a_sma>=s.a_t: log("Insertion (cutoff)"); done=True; break
            for st in list(grp):
                lim=st.max_burn is not None and (t-t_ign)>=st.max_burn
                if prop[id(st)]<=0 or lim:
                    prop[id(st)]=0 if not lim else prop[id(st)]
                    if st.parallel: attached.discard(id(st)); log(f"{st.name} burnout+jettison")
                    elif last: log("Insertion (burnout)"); done=True; break
                    else:
                        log(f"{st.name} burnout (MECO/SECO)"); attached.discard(id(st)); gi+=1
                        nx=seq[gi][0]; coast_until=t+nx.coast_before; t_ign=coast_until
                        if gi>=s.lt_from and lt_t0 is None: lt_t0=coast_until
                        pend_ign=nx.name if nx.coast_before>0 else None
                        break
        if record: rows.append((t,r.copy(),v.copy()))
        return (t,r,v),rows,ev
    def _state(s,name,t,r,v,m):
        ecef_r=rotz(-WE*t)@r; lat,lon,h=ecef2geod(ecef_r); vrel=v-np.cross([0,0,WE],r)
        rn=np.linalg.norm(r); fpa=math.degrees(math.asin(np.dot(r,v)/rn/np.linalg.norm(v)))
        return dict(event=name,t_s=round(t,1),alt_km=round(h/1e3,2),v_inertial_km_s=round(np.linalg.norm(v)/1e3,4),
                    v_rel_km_s=round(np.linalg.norm(vrel)/1e3,4),fpa_inertial_deg=round(fpa,3),mass_kg=round(m,1),lat=round(lat,4),lon=round(lon,4))
    def cost(s,x):
        end,_,ev=s.run(x)
        if end is None: return 1e6
        t,r,v=end; rn=np.linalg.norm(r); h=ecef2geod(rotz(-WE*t)@r)[2]; fpa=math.degrees(math.asin(np.dot(r,v)/rn/np.linalg.norm(v)))
        en=np.dot(v,v)/2-MU/rn; a=-MU/(2*en) if en<0 else 1e8
        c=((h-s.h_t)/5e3)**2+(fpa/0.25)**2-0.05*ev[-1]["mass_kg"]/(s.payload+1e3)  # constraints + fuel-optimal preference
        if ev[-1]["event"].startswith("Insertion (burnout)") or s.cutoff!="energy": c+=((a-s.a_t)/20e3)**2
        return c
    def solve(s):
        g=s.V["guidance"]; x0=np.array(g.get("x0",[3.0,0.5,0.003])); best=None
        for k in g.get("kick_grid",[x0[0]]):
            for t0 in [0.2,0.6,1.0]:
                xs=np.array([k,t0,x0[2]]); c=s.cost(xs)
                if best is None or c<best[1]: best=(xs,c)
        res=minimize(s.cost,best[0],method="Nelder-Mead",options=dict(maxiter=400,xatol=1e-4,fatol=1e-4,initial_simplex=None))
        return res.x,res.fun

def write_outputs(sim,x,outdir,slug):
    end,rows,ev=sim.run(x,record=True)
    L=sim.L; T0=dt.datetime.strptime(L["t0_utc"],"%Y-%m-%dT%H:%M:%SZ"); os.makedirs(outdir,exist_ok=True)
    fn=os.path.join(outdir,f"{slug}_ascent_ecef_5s_sim.csv"); w=np.array([0,0,WE]); rng=0.; prev=None; out=[]
    with open(fn,"w") as f:
        f.write(f"# ILLUSTRATIVE ASCENT ECEF — {L['title']} — NOT OFFICIAL TELEMETRY\n")
        f.write("# Method: first-principles 3DOF sim (/workspace/trajectory-deck/sim/ascent3dof.py): WGS-84 rotating Earth, J2, US76 drag,\n")
        if hasattr(sim,"free"):
            P=sim.params(x)
            f.write("#   TIMELINE mode: every ignition/cutoff/separation/fairing time is a published hard event; mdot=F_vac/(Isp_vac*g0); thrust SL/vac on ambient pressure.\n")
            f.write(f"#   FITTED (least squares vs published knots): vertical rise {P['vertical_rise_s']:.2f} s, kick {P['kick_deg']:.3f} deg over {sim.t_kick:.0f} s, Cd {P['cd']:.3f}, payload {P['payload_kg']:.0f} kg,\n")
            f.write(f"#   gravity turn, then linear-tangent steering tan(theta)={P['tan0']:.4f}-{P['tan_rate']:.6f}*(t-t_ign stage {sim.lt_from}).\n")
        else:
            f.write(f"#   thrust SL/vac interpolated on ambient pressure, mdot from Isp, staging/fairing/coast events; vertical rise to {sim.t_vert:.1f} s (rule: config guidance),\n")
            f.write(f"#   pitch kick {x[0]:.3f} deg over {sim.t_kick:.0f} s, gravity turn, linear-tangent upper-stage steering tan(theta)={x[1]:.4f}-{x[2]:.6f}*(t-t_ign), solved by optimizer.\n")
        f.write(f"# Vehicle config: {sim.V['name']} (sim/vehicles/{sim.V['id']}.json; every number carries a source URL, derivation, or ASSUMPTION).\n")
        for l in sim.V.get("header_notes",[])+L.get("header_notes",[]): f.write("# "+l+"\n")
        f.write(f"# Target (see launch config): insertion {sim.h_t/1e3:.0f} km, apoapsis {sim.ha_t/1e3:.0f} km, fpa 0, launch azimuth {math.degrees(sim.az):.2f} deg; payload {sim.payload:.0f} kg.\n")
        f.write(f"# Pad: {sim.lat0:.6f}N {sim.lon0:.6f}E. Frame: WGS-84 ECEF, positions km, velocities km/s (Earth-relative).\n")
        f.write(f"# T0 used: {L['t0_utc']}. Re-run with another T0 by shifting utc_iso only; ECEF geometry is Earth-fixed.\n")
        f.write("elapsed_s,utc_iso,lat_deg,lon_deg,altitude_km,range_along_track_km,x_ecef_km,y_ecef_km,z_ecef_km,vx_ecef_km_s,vy_ecef_km_s,vz_ecef_km_s,rel_vel_km_s,source\n")
        for t,r,v in rows:
            R=rotz(-WE*t); re=R@r; ve=R@(v-np.cross(w,r)); lat,lon,h=ecef2geod(re)
            if prev is not None:  # ground range along track (great-circle increments on sphere at surface)
                a1,b1=map(math.radians,prev); a2,b2=math.radians(lat),math.radians(lon)
                rng+=6371.0088*2*math.asin(math.sqrt(math.sin((a2-a1)/2)**2+math.cos(a1)*math.cos(a2)*math.sin((b2-b1)/2)**2))
            prev=(lat,lon); utc=(T0+dt.timedelta(seconds=float(t))).strftime("%Y-%m-%dT%H:%M:%SZ")
            if t==0: ve=np.zeros(3)
            f.write(f"{t:.3f},{utc},{lat:.7f},{lon:.7f},{h/1e3:.3f},{rng:.3f},{re[0]/1e3:.6f},{re[1]/1e3:.6f},{re[2]/1e3:.6f},{ve[0]/1e3:.6f},{ve[1]/1e3:.6f},{ve[2]/1e3:.6f},{np.linalg.norm(ve)/1e3:.6f},sim3dof-{sim.V['id']}\n")
            out.append((t,lat,lon,h/1e3))
    evj=dict(slug=slug,t0_utc=L["t0_utc"],illustrative=True,method="first-principles 3DOF sim",guidance_solution=(sim.params(x) if hasattr(sim,"free") else dict(kick_deg=x[0],tan0=x[1],tan_rate_per_s=x[2])),
             target=L["target"],events=ev)
    json.dump(evj,open(os.path.join(outdir,f"{slug}_events_sim.json"),"w"),indent=1)
    write_kml(fn,os.path.join(outdir,f"{slug}_ascent_sim.kml"),slug)
    return fn,np.array(out),ev

def write_kml(csvfn,kmlfn,slug):
    import csv,html
    hdr=[l[2:].strip() for l in open(csvfn) if l.startswith("#")]
    rows=list(csv.DictReader(l for l in open(csvfn) if not l.startswith("#")))
    coords=" ".join(f"{r['lon_deg']},{r['lat_deg']},{float(r['altitude_km'])*1000:.0f}" for r in rows)
    pm="".join(f"<Placemark><name>T+{float(r['elapsed_s']):.0f}s</name><TimeStamp><when>{r['utc_iso']}</when></TimeStamp><description>ILLUSTRATIVE alt {r['altitude_km']} km, range {r['range_along_track_km']} km, {r['source']}</description><Point><altitudeMode>absolute</altitudeMode><coordinates>{r['lon_deg']},{r['lat_deg']},{float(r['altitude_km'])*1000:.0f}</coordinates></Point></Placemark>" for r in rows if float(r['elapsed_s'])%30==0 or r is rows[-1])
    p=rows[0]; d=html.escape("\n".join(hdr))
    k=f'''<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>ILLUSTRATIVE {slug} ascent (3DOF sim)</name><description>{d}</description>
<Placemark><name>Pad ({slug})</name><Point><coordinates>{p['lon_deg']},{p['lat_deg']},0</coordinates></Point></Placemark>
<Placemark><name>ILLUSTRATIVE ascent polyline</name><LineString><altitudeMode>absolute</altitudeMode><tessellate>0</tessellate><coordinates>{coords}</coordinates></LineString></Placemark>
<Folder><name>30 s marks (ILLUSTRATIVE)</name>{pm}</Folder></Document></kml>'''
    open(kmlfn,"w").write(k)

def main():
    ap=argparse.ArgumentParser(); ap.add_argument("launch"); ap.add_argument("--outdir",default=None); a=ap.parse_args()
    here=os.path.dirname(os.path.abspath(__file__)); L=json.load(open(a.launch))
    vfn=os.path.join(here,"vehicles",L["vehicle"]+".json"); V=json.load(open(vfn))
    if V.get("timeline"):
        from timed import TimedSim
        fam=V.get("fixed_params",{}).get("cd",{})
        if isinstance(fam,dict) and fam.get("value") is None and "family_from" in V:   # family transfer of fitted values
            src=json.load(open(os.path.join(here,"vehicles",V["family_from"]+".json")))["fitted_family"]
            for k in V["fixed_params"]:
                if V["fixed_params"][k].get("value") is None: V["fixed_params"][k]["value"]=src[k]["value"]
        sim=TimedSim(V,L)
    else: sim=Sim(V,L)
    x,c=sim.solve(); outdir=a.outdir or os.path.join(here,"out",L["slug"])
    if V.get("timeline"):
        r,tab,fin=sim.residuals(x,detail=True); P=sim.params(x)
        L["fitted"]=dict(status="FITTED",method="scipy least_squares (TRF, bounded) vs published knots + target orbit",
            params={k:dict(value=round(float(P[k]),6),bounds=V["fit"][k]["bounds"],basis=V["fit"][k]["basis"]) for k in sim.free},
            fixed={k:float(v) for k,v in sim.fixed.items()},knot_residuals=tab,final=fin,cost=float(c),mass_budget=sim.mass_budget())
        json.dump(L,open(a.launch,"w"),indent=1,default=float)
        if V.get("is_family_reference"):
            V["fitted_family"]={k:dict(value=round(float(P[k]),5),status="FITTED",fit_run=L["slug"]) for k in ("cd","vertical_rise_s","kick_deg")}
            json.dump(V,open(vfn,"w"),indent=1,ensure_ascii=False)
    fn,rows,ev=write_outputs(sim,x,outdir,L["slug"])
    print(L["slug"],"cost",round(c,4),"x",np.round(x,5)); [print("  ",e) for e in ev]
if __name__=="__main__": main()
