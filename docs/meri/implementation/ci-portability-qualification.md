# UI CI portability qualification

The hosted UI verifier on candidate 7ac331dde failed with ERR_REQUIRE_ESM: its Node 20.11.1 pin is below the installed jsdom engine requirement (^20.19.0, ^22.13.0 or >=24). The workflow now uses Node 22, matching the locally qualified major (22.23.3). Dependency versions and test selection are unchanged.

The hosted final UI verifier separately detected generated route-file drift. Exactly eight source-comment paths used Windows separators. The generator now normalizes those comment paths to forward slashes. The generated exports, 155 patterns, two exclusions and manifest hash are unchanged. Removing comments produces the identical export-body SHA256 6eff7cbaa632683f9f5dfb0620d578a465d10129ee5c8f5bfe53a542b6760920. This does not introduce a routing change.

Generator write/check, scoped formatting and diff checks exit 0. Both complete UI verifier qualifications preceding this portability-only change remain recorded separately (142 and 164 tests, typechecks and builds). Independent Hermes/Bedrock Kimi static review returns SCOPED PASS with process exit 0. Review does not establish a hosted pass; current hosted checks remain required.

Evidence: C:/dev/cap-meri-foundation-evidence/preview-generator-platform-diagnosis.json, preview-generator-portability-proof.json and review-ci-portability*.
