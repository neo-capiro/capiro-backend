# C2 Krisp notes and generated debrief qualification

Feature PRs #2273 and #2274 are merged. C2 Strategies now keeps Krisp's finished
notes unchanged in Meeting Notes and runs Meri's existing debrief generator on those
notes. Other tenants continue to generate both artifacts from Krisp transcripts.
The import still commits the approved note, approved debrief, and completed import
atomically under its existing lease, ownership, tenant flag, connection, consent,
and meeting checks. No schema, flag, or client-association change is included.

Production was inspected before building. The live API source was
`7d2d19bf572b58f5fd17ab5f3f79e85d027b2d93`, the engagement worker source was
`5e597983c114b778b79f0e27b92cc497ad437066`, and the web source was
`e04b01744570134e9b1f0316b2fa377e89057505`. Each release branch overlays
only its relevant files onto that service's exact live source. The source files
for the changed Krisp importer and UI were byte-identical between those live
bases and the feature PR base. The API overlay also packages an operator-only
historical conversion script; the worker overlay carries no operator script.

| Service | Exact source | CodeBuild ID | Pinned image digest |
| --- | --- | --- | --- |
| API | `1e99f0921b207318c6d2abf03927b5c4daa5768b` | `capiro-build-web-dev:55ad0325-c9fa-4d11-9e09-714abf75c307` | `sha256:0a2ea000b74b164f0080ee84f61554f59784d2caecb0f97bae59ac3eb44474c0` |
| Engagement worker | `192cca3a1386eb2ceb370e01f6041e338709ab24` | `capiro-build-web-dev:d8007a9d-3c2b-40d3-9eaf-812e7d789447` | `sha256:e23a4a9d79d625649d24a9d9e54f843d110669e50c0a341cf72f5aa71f14c441` |
| Web vNext | `b4af4110b3e9661c5249fa1cfa59d844eb2bf0e7` | `capiro-build-web-dev:3220e995-ce39-45f1-bdd1-284940c4dda3` | `sha256:0c4542f558105822ee512f97fd01810604ef977eccf9aef9f0d2b700b125a730` |

All three CodeBuild runs succeeded on ARM64 and checked the exact resolved Git
SHA, AWS account, build-isolation guard, image architecture, and packaged output
before ECR publication. Their exact inline buildspec inputs are saved beside this
document. The first API candidate build was deliberately stopped after inspection
found that the one-time operator script must not claim background-worker ownership.
The API image above contains the fix in #2274. Two redundant worker/web build
starts were also stopped before publication; the successful IDs above are the
qualified runs.

Local focused checks passed on the merged feature source: 27 Krisp service/helper
tests, 8 operator-backfill tests, 5 Krisp settings UI tests, API TypeScript checking
with an 8 GB Node heap, and the build-isolation guard. The first 4 GB type-check
attempt exhausted its heap; the 8 GB rerun exited successfully. CodeBuild's API
and worker images compiled the relevant TypeScript at their exact overlay source;
the web build ran its TypeScript and Vite production build. Packaged probes checked
the operator script syntax, compiled worker flow, and served web copy respectively.

The historical conversion is dry-run-first and reuses the same C2 tenant,
membership, consent, connection, and meeting authorization predicate as the
importer. It selects only completed imports with an unshared debrief whose
encrypted body still exactly matches its paired Krisp note, and rechecks the
same conditions and client assignment before updating the debrief. It leaves the
Krisp Meeting Note untouched, skips shared or edited debriefs, and can resume
after interruption. The operator task must run from the new API image after
promotion; no historical conversion has been claimed at qualification time.

No retired Hermes runtime or schema dependency was added by these scoped
overlays. The existing Krisp tenant flag and personal opt-in remain in force.
Production health and authenticated application acceptance are required after
guarded promotion; build success alone is not that acceptance.
