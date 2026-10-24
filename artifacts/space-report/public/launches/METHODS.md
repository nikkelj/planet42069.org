# Launches: how the trajectory files are made

**Every trajectory here is ILLUSTRATIVE. None of it is telemetry or an official flight path.** Each launch gets two independent estimates, so you can compare them.

## 1. Surrogate (published-profile): `trajectory.csv` / `trajectory.kml`
- **Event knots:** time, altitude and velocity at key events (staging, fairing jettison, cutoff), taken from official vehicle brochures and user manuals (Rocket Lab Electron Payload User's Guide; CALT LM-3A Series User's Manual).
- **Interpolation:** smooth interpolation between knots, sampled every 5 s.
- **Ground path:** a constant-azimuth (rhumb) line from the pad. The azimuth comes from NOTAM/maritime hazard areas when available (LM-4B: ZJ385/26, RKRR D3252/26, RJJJ P5065/26; LM-8A: NAVAREA XI 26-0481), otherwise from the target inclination (Electron: 97° SSO → 189°).
- **One assumption:** a single horizontal-split assumption turns the published speed and altitude profile into downrange motion.
- **Family stand-in:** when a vehicle has no published profile (LM-4B, LM-6A, LM-8A), the LM-3B profile from the CALT manual is used. Each file's header says so.

## 2. First-principles 3DOF sim: `trajectory_sim.csv` / `trajectory_sim.kml`
A point-mass ascent simulator (`ascent3dof.py`):
- Rotating WGS-84 Earth with J2 gravity, integrated with RK4 at a 0.5 s step.
- US Standard Atmosphere 1976 density for drag. Thrust is interpolated from sea-level to vacuum values using ambient pressure. Mass flow comes from Isp.
- Staging, parallel boosters, fairing jettison and coasts.
- Guidance: vertical rise, pitch kick, gravity turn, then linear-tangent steering. A Nelder-Mead optimizer tunes the steering to reach the target orbit (flight-path angle 0 at the target altitude) along the launch azimuth.
- Stage parameters (propellant, dry mass, thrust, Isp, burn time) come from open sources. Every number in the vehicle files has a source URL, a worked derivation, or an explicit assumption label. Payload masses and target orbits for the Long March flights are labelled guesses, and LM-8A's orbit is unknown.

**Validation:**
- *Electron vs Payload User's Guide 8.0:* stage cutoff and ignition times match within about 1–2 s. Altitude runs 4–22 km low around fairing separation.
- *LM-3B vs CALT LM-3A Series manual (tuned):* every event time is now pinned to the manual (booster shutdown 127.2 s, stage-1 shutdown 144.7 s, fairing 215.2 s, S2 shutdown 325.5 s, S3 first shutdown 615.7 s), and burn rates are derived from published thrust and Isp. The remaining free settings (pitch-over, drag, payload, steering) are fitted to all nine manual altitude and ground-range points. Altitude is now within 3.4 km at every event (before: up to 26 km low) and ground range within 4.6 km up to S2/S3 separation and 9.3 km at S3 shutdown.
- *LM-4B vs published Y51 event sequence (tuned):* all event times now match exactly (stage-1 153.06 s, fairing 198.56 s, S2 282.49 s, S3 shutdown 648.68 s); before, the sim reached orbit 18 s late. Payload mass is fitted (about 1.6 t) to reach the assumed 500 km orbit at the published shutdown. No LM-4B altitudes are published, so altitude is unvalidated.
- *LM-6A / LM-8A:* only the fitted drag value carries over from LM-3B; their kerolox engines and timelines are unpublished, so they keep the untuned method.

## File format (CSV, both types)
`#` lines at the top give provenance. The columns are:
| column | meaning |
|---|---|
| elapsed_s | seconds since liftoff |
| utc_iso | UTC timestamp (T-0 from Launch Library 2) |
| lat_deg, lon_deg | geodetic WGS-84 latitude and longitude |
| altitude_km | height above the WGS-84 ellipsoid |
| range_along_track_km | ground distance from the pad |
| x/y/z_ecef_km | WGS-84 Earth-centred, Earth-fixed position, km |
| vx/vy/vz_ecef_km_s | ECEF (Earth-relative) velocity, km/s |
| rel_vel_km_s | Earth-relative speed, km/s |
| source | how that row was produced |

The frame is WGS-84 ECEF, in km and km/s. There is a row every 5 s from liftoff to orbit insertion.

## KML
KML 2.2. The 3D ascent line uses `altitudeMode` absolute (metres above the ellipsoid), with time-stamped placemarks every 30 s plus event markers. It opens in Google Earth. Turn on the time slider to animate it.

## References
1. **Rocket Lab Electron Payload User's Guide v8.0** (`rl-ug`) — https://rocketlabcorp.com/assets/Rocket-Lab-Electron-Payload-User-Guide-8.0.pdf
2. **CALT LM-3A Series Launch Vehicles User's Manual, Issue 2011** (`calt-lm3a`) — http://www.georing.biz/usefull/LM-3A%20Series%20Launch%20Vehicles%20User's%20Manual%20Issue%202011.pdf
3. **Wikipedia: Rocket Lab Electron** (`wp-electron`) — https://en.wikipedia.org/wiki/Rocket_Lab_Electron
4. **Wikipedia: Long March 3B** (`wp-lm3b`) — https://en.wikipedia.org/wiki/Long_March_3B
5. **Wikipedia: Long March 4B** (`wp-lm4b`) — https://en.wikipedia.org/wiki/Long_March_4B
6. **Wikipedia: Long March 6A** (`wp-lm6a`) — https://en.wikipedia.org/wiki/Long_March_6A
7. **Wikipedia: Long March 8** (`wp-lm8`) — https://en.wikipedia.org/wiki/Long_March_8
8. **Huiji Satellite Wiki: 长征四号乙 (Long March 4B event times)** (`huiji-lm4b`) — https://sat.huijiwiki.com/wiki/长征四号乙
9. **NAVAREA XI 26-0481 (LM-8A drop zones, Sulu Sea) via sealagom** (`navarea-xi-26-0481`) — https://www.sealagom.com/navarea/11/message/25242/
10. **China MSA debris-zone notice ZJ385/26 (LM-4B Jiuquan)** (`zj385`) — notice ID only; no stable public URL captured
11. **NOTAM RKRR D3252/26 (Incheon FIR, LM-4B hazard area)** (`rkrr-d3252`) — notice ID only; no stable public URL captured
12. **NOTAM RJJJ P5065/26 (Fukuoka FIR, LM-4B hazard area)** (`rjjj-p5065`) — notice ID only; no stable public URL captured
13. **The Space Devs Launch Library 2 API v2.3.0 (launch times/status)** (`ll2`) — https://ll.thespacedevs.com/2.3.0/launches/
14. **OGC KML 2.2 namespace/specification** (`kml`) — http://www.opengis.net/kml/2.2
15. **Wikipedia: YF-20 (sea-level vs vacuum thrust and Isp)** (`wp-yf20`) — https://en.wikipedia.org/wiki/YF-20
