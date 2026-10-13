# Current Newsletter producer handoff — 13 October 2026

Candidate frozen frontend: `neo-capiro/capiro-frontend@c8aa693e884de86001d2fc04fbb60d48db09341c`, root tree `9d11bfbd7121887bc06f5cb793e8a4c4e6e682b4`, application tree `79ae91f7a119e98b7ba612ceed2a4ca661944888`. The combined local qualification on this exact source passed; see QUALIFICATION.md for gate counts, failures/corrections and limitations. PR17's separately qualified source `d4be41e60516e576c74afa304b50ed67da15cb93` and published evidence head `6dacdaca3507bf75a472f5860ac72fc483377248` are unchanged. This handoff must not delay or alter that separate shipping source.

There is **no approved musl producer artifact, exhaustive manifest or build provenance available for c8aa** in this frontend qualification work. The active host is Linux/glibc, Node24.19.0. Local Next production output produced here cannot be declared Node24.21/Alpine/musl output. Historical 7c output/archive also cannot be relabelled c8aa.

## Required build and evidence

After source acceptance, the designated producer must build the exact accepted checkout, with its own clean locked dependency install, on the target selected by the shipping owner (`linux/amd64` or `linux/arm64`). The frozen frontend `apps/web/Dockerfile` blob `575c2216592b0fa7e8db183f9a8e0df931c102fd` specifies the runtime:

- `node:24.21.0-alpine3.23@sha256:9ec4a2e289874ed0d722e1772ec2de45d2801541db8612f3638b26f128c69ac2`;
- musl, Node major24, `zlib=1.3.2-r1` and CA certificates;
- root `npm ci --ignore-scripts --no-audit --no-fund`, then root `npm run build`;
- standalone entry `apps/web/server.js`, nonroot `node` user; consumer port8080 is an intentional adaptation from frontend5188.

Capture the clean commit/tree and lockfile hash, actual build context/exclusions, resolved image/platform, Node/npm/Alpine/musl/native module identities, effective nonsecret build configuration, exact commands, exit statuses and complete producer logs. A caller-supplied commit string or successful local glibc build is not build-source or ABI provenance. Preserve the three exact built inputs: `apps/web/.next/standalone`, `apps/web/public`, and `apps/web/.next/static`. Do not install or rebuild during assembly, and do not add ungoverned host files into the output.

The producer inventory must cover the complete mapped overlay, including server/static/trace closure and all179 newsletter assets (486014 canonical source bytes). The assembly contract requires exact file SHA256/byte lengths and relative symlink text, source repository/commit, target OS/architecture/musl/Node24 and entrypoint. Supply the manifest's measured raw SHA256 plus the separate provenance above. Limits are20000 entries,512MiB total regular bytes,64MiB per file and16MiB manifest; an oversized output is a reported blocker, not permission to omit required files. Source asset continuity and all179 actual local standalone HTTP asset responses passed exact size/SHA comparison. This is glibc serving evidence; target-musl runtime and image qualification remain unrun.

## Backend admission blocker

At `capirov2@9db4e1cd5589a05e08fb88caa38a4ac44937def5`, the seven-flag consumer is generic but the assembly profile in `scripts/lib/newsletter-artifact-packaging-plan.mjs` hard-pins `7c87678730538958ace9762f824dc3e588bf445b`. Both plan and run reject c8aa. The backend owner must publish a reviewed successor profile, explicit exact-source acceptance/refusal tests, usage and operator documentation after the frontend source is accepted. Preserve strict profile equality and historical receipts. See `consumer-source-admission/review.md` for exact blobs and lines.

Only after both actual producer inputs and the matching approved profile exist can the existing builder run `--plan` with every required flag, and later explicitly assemble the reviewed inputs. Assembly is not frontend, image, native-runtime, routing or shipping qualification. No image build, AWS action, deployment, provider call or application service mutation was executed for this handoff.
