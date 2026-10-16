# Historical visual CLI control inputs

The two `.mjs.txt` operands and `package.json` are exact bytes extracted from Git commit `4e0c189c5d0522098be1c4916a033bb681d11c0b`. `SOURCE-INPUTS.json` records each original path, byte count, SHA-256 and Git blob. The package is historical data outside workspace globs; it is never installed. Missing or altered operands fail before temporary execution fixtures are created.

`scripts/cleanup-script-smoke/web-visual-cli-controls.mjs` retains its 27 original scenarios and 144 original assertions: 22 no-argument/help/unknown/configuration checks, two explicit-mode resource refusals, one deliberate trap proof and two package assertions. The three script basenames and all existing check labels remain. The already relocated Phase 1 harness is verified through its exact recorded path inverse; it is not duplicated into this archive.

It now requires exactly `--historical-replay` before reading archive operands or creating fixtures. Missing/malformed intent exits 2; `--help` exits 0 without executing cases. All 27 scenario bodies and 144 assertions remain. Canonical current frontend parity owner is `capiro-frontend`; `../QUALIFICATION-OWNERSHIP.json` records the cases and inherited outcomes. The current backend catalog excludes this suite and verifies immutable input bytes without claiming its package assertions pass.

Script bodies are materialized into a separate temporary input directory so the original resource trap can still assert that the calling directory stays empty. Browser-package ESM and CJS ports are inert and refuse execution; no Chrome, Lighthouse dependency, browser, network or database is used. Original filesystem/subprocess/network traps and explicit-mode markers remain. Child Node heaps are capped at 64 MiB; parent uses 128 MiB and an external 120-second wall limit.

## Preserved failures

Exact source inspection found two inherited package/CLI mismatches:

| Original assertion identity | Actual historical value | Required value |
| --- | --- | --- |
| `package Lighthouse command must opt into Chrome` | `node scripts/lighthouse-pe-watch.mjs` | `node scripts/lighthouse-pe-watch.mjs --run` |
| `package capture command must opt into writes` | `node scripts/vnext-visual-capture.mjs` | `node scripts/vnext-visual-capture.mjs --capture` |

Both original `assert.equal` expressions execute once. Failures are collected separately so the first cannot hide the second; the command retains a failing exit when either assertion fails. Archived bytes and expected assertions are unchanged. `OBSERVATIONS.json` records the source proof and expected historical outcome; it is not a native execution receipt or a green baseline.

After 25 successful inert runtime scenarios, the command emits `Historical Web visual CLI runtime controls COMPLETE`, then emits `HISTORICAL_WEB_VISUAL_PACKAGE_ASSERTIONS_FAILED` with both observations and exits 1. An earlier runtime-control failure remains a distinct unexpected failure. This historical package qualification is separate from current backend acceptance.

Explicit historical replay command (no rerun is required for current backend source acceptance):

```text
node --max-old-space-size=128 scripts/cleanup-script-smoke/web-visual-cli-controls.mjs --historical-replay
```

No test, compiler, install or browser ran in this lane. These inputs permit retirement of the old main-Web automation files without dropping their CLI/refusal scenarios; they do not qualify a currently served frontend.
