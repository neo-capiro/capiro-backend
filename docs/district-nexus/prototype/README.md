# District Nexus UI prototype — extracted reference

These files are the **binding visual specification** for Workstream G (the District
Nexus map page). Product direction, 2026-07-25: *"anything UI related must match the
prototype exactly."*

## Where they came from

`C:\Users\neoma\Downloads\District Nexus (offline).html` is a self-contained offline
bundle and is not readable as-is: ~398 lines where line 383 is a ~785 KB JSON asset
map (`{uuid: {mime, compressed, data: <base64 gzip>}}`) and line 395 is the real page
markup as a JSON-escaped string. Extraction:

- **markup** — take line 395, build `'{"h":' + line395 + '}'`, `ConvertFrom-Json`, read `.h`
- **assets** — parse line 383 as JSON; `[Convert]::FromBase64String(.data)`, then
  GZipStream-decompress where `.compressed` is true

They are committed here because the extraction previously lived only in `%TEMP%`, and
this project has already lost 7 unpushed commits to a dead machine. Re-extracting a
1,205-line `app.js` mid-build is pure waste.

## What each file is

| File | What it pins |
|---|---|
| `dn-app.css` | The full CSS token set — canvas `#f4f2ec`, dark `#0c1a38`, accent `#2a57ce`, serif page titles, mono tabular numerics. Layout geometry and the z-index stacking bands. |
| `app.js` | The entire UI: choropleth colour ramp and stops, score bands, hover card, drawer, filter semantics, legend, interaction behaviour. |
| `sample-data.js` | The de-facto API contract for WS-E1/E2 — per-district `rows/contracts/grants/policy/targets/acs`, the separate `UNPLACED` and `UNPLACED_CONTRACTS` buckets, `FRESHNESS` per ingestion rail, `RESOLUTION_QUEUE`, and `OPPS` carrying `rel`/`elig`/`signals`. |
| `markup.html`, `dn-body.html` | DOM order and the exact visible copy for every component. |

## Two things to know before using it

**It is a visual spec, not source to port.** The prototype is built on Leaflet (240
references, zero MapLibre). The implementation stack is MapLibre — `maplibre-gl@^5` plus
`@vis.gl/react-maplibre` — per the Rev 2 plan §4.2/§7-G. Reproduce the *appearance*;
do not port the map code. WS-G needs deliberate visual-parity QA against these files,
in the style of the legiwatch prototype-to-CSS reconciliation.

**Its honest-state discipline is part of the spec, not decoration.** `emp:null` is
commented "null ≠ 0"; opportunities are visually separated (dashed border, muted) and
never summed into awarded dollars; the "Enacted future" toggle ships *disabled* with
the title "No enacted-future boundary artifact has been built yet". Scoring matches
plan §7-F and adds two rules the plan left open: an ambiguous facility geocode gets
half facility weight, and a recipient-location basis scores 4 of 10. Bands are
Strong ≥60, Moderate ≥35, Limited ≥15, Minimal ≥0.

Not committed from the extraction: `leaflet.js` (wrong stack) and `districts.geojson`
(465 KB of simplified sample polygons — the real artifact is built by
`build-district-boundary-artifacts`).
