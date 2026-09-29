# Outreach vNext generator qualification

The generator now reproduces the already merged vNext stylesheet without reverting its design. The generated rule body is unchanged; only its explanatory banner changes. The standalone canonical stylesheets, UI components, routes, and model policies are untouched.

## Authority and bounded adaptations

Base: `7823d63cec2297fa8c5abecbeac38d8f9dd42d26`. Commit `bac572623b654199ab374da0d1656ed8543298c8` deliberately unified foundation sans/mono families, 1179px/779px boundaries, sticky layers, and the inset focus treatment, including the undefined mono fix. Commit `470aa86f8` deliberately applied the warm surfaces and outer selection shadows. Those changes had edited the port directly while its generator still only scoped selectors and dropped root tokens.

`applyVNextDesign` records these as exact, counted, source-specific policies before the existing mechanical transform. Typography and media declarations have per-source counts; surface/focus/layer adaptations retain exact selector context. Missing, changed, or duplicate anchors fail generation. These are the existing vNext decisions, not generic style normalization. Unrelated canonical declarations remain unchanged. Future canonical anchor changes require reviewing the corresponding policy; regenerating must not silently overwrite the vNext choices.

The three canonical request-dialog blocks remain excluded, with exact content/count validation and rejection of additional request-dialog rules. `OUTREACH-PROTOTYPE-PARITY.md` section 5a explicitly omits this unsupported form. Current vNext TSX contains no `GoalDecisionSurface` or `ov3-request-modal` consumer; `outreach-step-targets.tsx` imports the port for `TargetDirectoryBrowser`. The canonical legacy stylesheet still retains all three blocks. No modal UI or route is added.

## Verification

- Exact generator check: PASS, exit 0.
- Generator tests: PASS, 19 tests, exit 0. Existing selector/keyframe/token/line-ending/cascade tests retained. New controls cover foundation choices, missing/changed/duplicate anchors, selector and focus mutations, changed/missing/duplicate/additional modal rules, and neutral declarations.
- Canonical source files: byte hashes identical before/after. Generated rule body equals the base Git blob after LF normalization: SHA-256 `550edf05dac7d936958a38968687a30e1c61bde5189e3cb0f78acc3dce8cfd81`. The only generated CSS diff is the banner.
- Independent Hermes/Kimi exact patch review is required before commit. Review artifacts and command logs remain outside the source checkout under `C:\dev\cap-meri-foundation-evidence`.
- This qualifies the generator and its artifact; it is not a browser canary or a deployed service claim.

Commands: `node scripts/port-outreach-decision-vnext-css.mjs --check` and `node scripts/port-outreach-decision-vnext-css.spec.mjs`.
