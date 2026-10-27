# ascent3dof — first-principles 3-DOF launch ascent sim (ILLUSTRATIVE)

Physics: WGS-84 rotating Earth + J2, US76 drag, thrust interpolated SL→vac on ambient pressure
(Ae=(Fvac−Fsl)/P0), mdot from Isp (or `mdot_from_burn_time`), staging / parallel boosters / fairing / coasts.
RK4, dt 0.5 s, integrated in ECI (=ECEF at T0), output in ECEF.
Guidance: vertical rise (fixed `vertical_rise_s` or `vertical_rise_until_vrel_mps`), pitch kick, gravity turn,
then linear-tangent steering tan(θ)=tan0−tanr·(t−t_ign) from stage index 1. Nelder-Mead solves [kick, tan0, tanr]
to hit target altitude with FPA=0, with a mild fuel-optimal preference. Cutoff on target energy or final burnout.

## Add a vehicle
Create `vehicles/<id>.json` (copy lm4b.json). EVERY number is an object with `value` plus exactly one of
`source` (URL), `derived` (show the arithmetic), or `assumption` (say why). Never invent numbers.
Stages: `propellant_kg, dry_kg, thrust_sl_N, thrust_vac_N, isp_vac_s, (burn_s), parallel, coast_after_s`.
Timeline-mode vehicles: see Validation below; add `ignition_s/cutoff_s/separation_s` per stage, `fit` bounds.
Low T/W vehicles (<1.3): use `vertical_rise_until_vrel_mps` (~60) and a small `kick_grid`.

## Run a launch
Create `launches/<slug>.json` with: slug, name, vehicle, pad lat/lon/alt, azimuth_deg, t0_utc, target
(perigee/apogee or altitude), payload_kg (each sourced or ASSUMPTION). Then:

    python3 ascent3dof.py launches/<slug>.json [--outdir DIR]

Outputs in `out/<slug>/`: `<slug>_ascent_ecef_5s_sim.csv` (EOS-05 column format), `<slug>_ascent_sim.kml`,
`<slug>_events_sim.json`. If it prints CRASH for all grid points, lower the kick / lengthen the vertical rise.

## Validation (tuned 2026-10-23)

Long March vehicles now run in **TIMELINE mode** (`"timeline": true`, `timed.py`): every ignition / cutoff /
separation / fairing time is a hard event from a published sequence; mdot = F_vac/(Isp_vac·g0) and burned
propellant = mdot × burn time; published load − burned is carried as residual (flagged if negative).
YF-21C/YF-20 published thrust/Isp are sea-level values; vacuum values derived with the YF-20 816.3/731.5 kN ratio
(mdot unchanged). LM-3B S2 verniers (47.1 kN) modelled as a tail running to the published vernier shutdown.
Free parameters (vertical rise, kick, Cd, payload, linear-tangent tan0/rate) are fitted by bounded
`scipy.optimize.least_squares` against ALL manual altitude + ground-range knots and the target orbit
(`fit_lm.py` / `ascent3dof.py`); fitted values, bounds and residuals are stored as `fitted` (status FITTED)
in `launches/<slug>.json`, family values in `vehicles/lm3b.json` → `fitted_family`.

**LM-3B vs CALT LM-3A Series manual 2011, Tables 3-5/3-6** (times now exact by construction):

| event | t pub | t before | t after | alt pub km | alt before | alt after | Δalt | range pub | range after | Δrange |
|---|---|---|---|---|---|---|---|---|---|---|
| Boosters shutdown | 127.2 | 130.5 | 127.2 | 53.9 | 49.9 | 56.7 | +2.8 | 68.7 | 72.7 | +4.0 |
| Stage-1 shutdown | 144.7 | 148.5 | 144.7 | 71.0 | 64.5 | 74.4 | +3.4 | 108.2 | 112.5 | +4.3 |
| S1/S2 separation | 146.2 | 150.0 (S2 ign) | 146.2 | 72.5 | 65.7 | 75.9 | +3.4 | 112.0 | 116.3 | +4.3 |
| Fairing jettison | 215.2 | 215.5 | 215.2 | 131.5 | 110.3 | 134.0 | +2.5 | 307.2 | 311.8 | +4.6 |
| S2 main shutdown | 325.5 | 333.0 | 325.5 | 190.3 | 163.7 | 187.4 | −2.9 | 744.8 | 747.6 | +2.8 |
| S2 vernier shutdown | 330.5 | — | 330.5 | 192.1 | — | 189.3 | −2.8 | 769.8 | 772.2 | +2.4 |
| S2/S3 separation | 331.5 | 334.0 (S3 ign) | 331.5 | 192.5 | 164.1 | 189.6 | −2.9 | 774.8 | 777.1 | +2.3 |
| S3 first shutdown | 615.7 | 600.5 | 615.7 | 204.3 | 204.3 | 205.4 | +1.1 | 2466.2 | 2456.9 | −9.3 |

Fitted: vertical rise 8.79 s, kick 7.80° / 10 s, Cd 0.667, payload 5,241 kg; final FPA −0.11°, SMA +15 km vs
assumed circular 204.3 km parking orbit. Modelled GLOW 427.0 t vs published 425.8 t (+0.3 %).
Residual pattern (≈+3 km high in S1, ≈−3 km low at end of S2) is irreducible with a single gravity-turn +
one linear-tangent law; CALT's real pitch program is unpublished. Cd 0.67 sits high in its bound and partly
absorbs that program error — treat as an effective value, not a measured drag coefficient.

**LM-4B vs huijiwiki Y51/LEO sequence** (S1 153.059, sep 154.259, fairing 198.558, S2 main 282.494, vernier
292.294, sep 293.294, S3 shutdown 648.684 s): before, sim reached orbit at 666.5 s (+17.8 s), S1 burnout 153.5,
S2 burnout 303.5 (+21 vs main shutdown), fairing 183.0 (altitude rule). After: all events exact; 500 km circular
target reached at 648.684 s with fitted payload 1,571 kg (FPA 0, SMA error <1 m); modelled GLOW 248.9 t vs
published 249.2 t (−0.1 %). Vertical rise fixed at published 20 s (Y43); Cd transferred from LM-3B fit.
Flags: published S2 load 34,267 kg < mdot×burn 34,648 kg (Y51's 128.2 s main burn exceeds the handbook 122.9 s),
load raised to burned. No published LM-4B altitudes, so altitude cannot be validated; the 14 s terminal velocity
trim burn (to 662.684 s) is not modelled (thrust unpublished).

**Electron** unchanged (old energy-cutoff mode): trajectory rows byte-identical to the pre-tuning run.

**LM-6A / LM-8A:** only the fitted Cd (0.667) was transferred (aero only). Engine/timing parameters were not:
they fly YF-100/YF-115 kerolox, no fitted vehicle shares those engines, and no event sequence is published.
Insertion times moved 741.5→743.5 s (LM-6A) and 761.0→763.0 s (LM-8A).

`altitude_compare.png`: surrogate vs pre-tuning sim vs tuned sim, plus LM-3B knots and residual bars.

## deploy_coast.py (post-cutoff, through deploy)
`python3 deploy_coast.py launches/<slug>.json [--outdir DIR]` extends `out/<slug>/` past final cutoff using the launch's `post_cutoff` block
(drag, burns[], deploy{t_s, src}). If `deploy.t_s` is null, it propagates TWO revolutions on the inferred insertion orbit, ending
"inferred insertion orbit, +2 revs (deploy time unpublished)". `deploy_coast.py` then copies those out/ files to
`artifacts/space-report/public/launches/<slug>/<slug>_<YYYY-MM-DD>_trajectory_sim.csv` and `.kml`
(the date is the launch `t0_utc`; surrogate files use the same pattern without `_sim`).
Point `launches/index.json` `files.csv_sim` / `files.kml_sim` at those paths, then run `scripts/build_launch_globe_assets.py`.
Note: the site's LM-8A files use T0 2026-10-25T02:03Z (retimed); the public date is still 2026-10-25.

## Per-launch stage event overrides (timeline mode)
A launch file may carry `stage_event_overrides`, keyed by stage index, to replace the vehicle file's event times with that
mission's published ones, e.g. Starlink 15-18 (SpaceX sl-15-18: MECO 2:26, sep 2:29, SES-1 2:36):
`"stage_event_overrides": {"0": {"cutoff_s": {"value": 146, "src": "..."}, "separation_s": {"value": 149, "src": "..."}}, "1": {"ignition_s": {"value": 156, "src": "..."}}}`. Without it the vehicle defaults apply.
