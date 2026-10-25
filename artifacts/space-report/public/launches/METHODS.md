# Launches: how the trajectory files are made

**Every trajectory here is ILLUSTRATIVE. None of it is telemetry or an official flight path.** Each launch gets two independent estimates, so you can compare them.

## 1. Surrogate (published-profile): `trajectory.csv` / `trajectory.kml`
- **Event knots:** time, altitude and velocity at key events (staging, fairing jettison, cutoff), taken from official vehicle brochures and user manuals (Rocket Lab Electron Payload User's Guide; CALT LM-3A Series User's Manual).
- **Interpolation:** smooth interpolation between knots, sampled every 5 s.
- **Ground path:** a constant-azimuth (rhumb) line from the pad. The azimuth comes from NOTAM/maritime hazard areas when available (LM-4B: ZJ385/26, RKRR D3252/26, RJJJ P5065/26; LM-8A: NAVAREA XI 26-0481), otherwise from the target inclination (Electron: 97° SSO → 189°).
- **One assumption:** a single horizontal-split assumption turns the published speed and altitude profile into downrange motion.
- **Family stand-in:** when a vehicle has no published profile (LM-4B, LM-6A, LM-8A), the LM-3B profile from the CALT manual is used. Each file's header says so.
- **Falcon 9 (Starlink 15-16):** SpaceX publishes event times but no altitude profile, so the altitude and downrange-vs-time curve comes from SpaceX webcast telemetry of a past Falcon 9 Block 5 Vandenberg launch with a droneship landing (Iridium NEXT-7, 2018; MECO at 146 s, the same as 15-16), via shahar603/Telemetry-Data. It is lightly smoothed, and range is integrated from the horizontal speed. The azimuth is the bearing to the centre of the far edge of NAVAREA XII 737/26 Hazard Area A (154.6°). The last 11 s, from the end of the telemetry to SpaceX's published SECO-1 at T+8:39, are extrapolated.

## 2. First-principles 3DOF sim: `trajectory_sim.csv` / `trajectory_sim.kml`
A point-mass ascent simulator (`ascent3dof.py`):
- Rotating WGS-84 Earth with J2 gravity, integrated with RK4 at a 0.5 s step (timeline-mode runs land every published event exactly, since cutoffs are hard events rather than energy triggers).
- US Standard Atmosphere 1976 density for drag. Thrust is interpolated from sea-level to vacuum values using ambient pressure. Mass flow comes from Isp.
- Staging, parallel boosters, fairing jettison and coasts.
- **Through payload deploy** (`deploy_coast.py`, added 25 Oct): after final upper-stage cutoff the stage keeps coasting under the same WGS-84/J2/US76-drag model, at 5 s rows, through any published restart or kick-stage burn (timing from the provider; thrust or duration solved to hit the sourced orbit) to the provider's published deploy time. Coast rows are tagged `-coast`/`-burn` in the `source` column, the header gains `POST-CUTOFF` lines with sources, and the KML gets a deploy placemark. If no deploy time is published, the stage is propagated from insertion for TWO revolutions (osculating period at insertion) on the inferred insertion orbit, with J2 and drag, and the file ends at a placemark labelled "inferred insertion orbit, +2 revs (deploy time unpublished)". Source: `tools/trajectory-sim/` in this repo. The globe thins coast rows to one every 30 s.
- Guidance: vertical rise, pitch kick, gravity turn, then linear-tangent steering. A Nelder-Mead optimizer tunes the steering to reach the target orbit (flight-path angle 0 at the target altitude) along the launch azimuth.
- Stage parameters (propellant, dry mass, thrust, Isp, burn time) come from open sources. Every number in the vehicle files has a source URL, a worked derivation, or an explicit assumption label. Payload masses and target orbits for the Long March flights are labelled guesses, and LM-8A's orbit is unknown.

**Validation:**
- *Electron vs Payload User's Guide 8.0:* stage cutoff and ignition times match within about 1–2 s. Altitude runs 4–22 km low around fairing separation.
- *LM-3B vs CALT LM-3A Series manual (tuned):* every event time is now pinned to the manual (booster shutdown 127.2 s, stage-1 shutdown 144.7 s, fairing 215.2 s, S2 shutdown 325.5 s, S3 first shutdown 615.7 s), and burn rates are derived from published thrust and Isp. The remaining free settings (pitch-over, drag, payload, steering) are fitted to all nine manual altitude and ground-range points. Altitude is now within 3.4 km at every event (before: up to 26 km low) and ground range within 4.6 km up to S2/S3 separation and 9.3 km at S3 shutdown.
- *LM-4B vs published Y51 event sequence (tuned):* all event times now match exactly (stage-1 153.06 s, fairing 198.56 s, S2 282.49 s, S3 shutdown 648.68 s); before, the sim reached orbit 18 s late. Payload mass is fitted (about 1.6 t) to reach the assumed 500 km orbit at the published shutdown. No LM-4B altitudes are published, so altitude is unvalidated.
- *Falcon 9 / Starlink 15-16 (tuned 25 Oct, timeline mode):* every event time is a hard event from SpaceX's sl-15-16 timeline (MECO 146 s, stage sep 150 s, SES-1 156 s, fairing 176 s, SECO-1 519 s; before tuning the sim reached SECO-1 at 527 s). Burn rates come from Block 5 Merlin thrust and Isp at full thrust (throttle profile unpublished); stage 1 is left with about 18 t at MECO, standing in for entry and landing propellant. The target is the SECO-1 parking orbit derived from SpaceX's own pre-launch state vector (CelesTrak SupGP, deploy orbit 252 × 265 km, 70.007°): SES-2 at T+53:01 is half an orbit after SECO-1, giving a 159 × 265 km parking orbit. The launch azimuth (155.45°) follows from that inclination and lies inside NAVAREA XII 737/26 Hazard Area A (151.8–157.3°). The azimuth was retuned on 25 Oct to 155.87° (still inside Hazard Area A): the textbook 155.45° gave a 69.67° orbit plane in the sim, now 70.04° osculating. Pitch-over, kick, payload and steering are fitted by bounded least squares, with Cd fixed at 0.4 (an assumption). Result: perigee within 0.01 km and semi-major axis within 0.02 km of the target, flight-path angle 0.001° at SECO-1, fitted stack mass 16.9 t (SpaceX does not publish it; 27 × ~575 kg community estimate is 15.5 t). Against Iridium NEXT-7 webcast telemetry (a lighter, different-orbit stand-in) the sim is 2.9–4.1 km high and 27–43 km further downrange at MECO, SES-1 and fairing separation, consistent with no Max-Q throttle-down being modelled.
- *Starlink 15-16 through deploy:* coast from SECO-1 (T+519 s) to SpaceX's SES-2 (T+53:01); the 2 s SES-2/SECO-2 burn's thrust is solved (about 329 kN, ~34 % of MVac's rated thrust; throttle unpublished) to raise perigee to the 252.1 km in SpaceX's state vector; coast to SpaceX's deploy at T+1:01:53. Deploy state: 263.8 km altitude, 12.65°N 63.50°E, osculating 254.7 × 264.5 km at 70.04°. CelesTrak's deploy-state epoch is 24 s later than SpaceX's page (SpaceX used).
- *Electron HawkEye 360, LM-4B, LM-6A, LM-8A (no published deploy time, +2 revs):* Electron 216 × 591 km, i 95.81°, ends T+11650 s; LM-4B 494.9 × 505.4 km, i 45.03°, ends T+12003 s; LM-6A 499.0 × 505.7 km, i 96.93°, ends T+12103 s; LM-8A 700.0 × 709.1 km, i 54.11°, ends T+12627 s (osculating). Upper-stage drag uses an assumed Cd 2.2 and frontal area. Electron's Kick Stage phase is deferred: the untuned ascent ends in a ~216 × 590 km orbit versus Rocket Lab's 520 km, so its +2 revs are on the sim's inferred orbit, not the Curie-circularised one.
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

The frame is WGS-84 ECEF, in km and km/s. There is a row every 5 s from liftoff through payload deploy, or through two revolutions after insertion when the deploy time is unpublished.

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
16. **SpaceX: Starlink 15-16 mission page and timeline** (`spacex-sl-15-16`) — https://www.spacex.com/launches/sl-15-16
17. **NAVAREA XII 737/26 (Starlink 15-16 hazard areas) via space-notices** (`navarea-xii-737-26`) — https://space-notices.com/notice/nav-warning-NAVAREA%20XII%20737%2F26
18. **USCG Local Notice to Mariners 56736, Sector San Diego** (`uscg-lnm-56736`) — https://space-notices.com/notice/nav-warning-NAVAREA%20XII%20737%2F26
19. **NOTAM MMFR B3055/26 (Falcon 9 stage-1 reentry)** (`mmfr-b3055-26`) — https://www.notamify.com/notams/MMFR/42c9513c-5fc7-4d3c-8ad8-cccd7e6a30de
20. **FAA operations advisory: SpaceX Starlink 15-16** (`faa-sl-15-16`) — https://space-notices.com/notice/infopage-faa-operations-advisory-spacex-starlink-15-16
21. **shahar603/Telemetry-Data: Falcon 9 webcast telemetry (Iridium NEXT-7)** (`shahar603-tel`) — https://github.com/shahar603/Telemetry-Data/tree/master/Iridium%20NEXT%207
22. **Wikipedia: Falcon 9** (`wp-falcon9`) — https://en.wikipedia.org/wiki/Falcon_9
23. **Wikipedia: Falcon 9 Block 5** (`wp-falcon9-b5`) — https://en.wikipedia.org/wiki/Falcon_9_Block_5
24. **Spaceflight Now launch schedule** (`sfn-schedule`) — https://spaceflightnow.com/launch-schedule/
25. **CelesTrak SupGP: Starlink G15-16 pre-launch elements (from a SpaceX-supplied state vector)** (`celestrak-supgp-g15-16`) — https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?FILE=starlink-g15-16&FORMAT=json
26. **Xinhua: Long March 8A launches SatNet LEO Group 28 (25 Oct 2026)** (`xinhua-lm8a-y12`) — https://www.news.cn/politics/20261025/3573644b269e466f83510360cb84eff4/c.html
