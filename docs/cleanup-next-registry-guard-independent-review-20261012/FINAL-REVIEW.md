# Independent bounded source acceptance

Accepted source: `4104f49f6ebfdbf00ad1706079ba340bd9b566c8`, tree
`257856362ba9075b25bee52debf3efa35f3dfb77`. Acceptance covers the finite
declaration/import/carrier source protocol and the existing Strategy vocabulary
profile. It does not accept an application extraction, a general module graph,
runtime registry behavior or native CI/DB/security behavior.

The unchanged independent vectors pass: original 24/24, additional binding/import
27/27 and ambient export 4/4. All 78 current author controls pass; every original
31 full name and every intermediate 65 full name remains exactly once. These
sets overlap and are not summed as unique coverage. The actual source-only CLI
returns one profile, 168 files and no errors. Help exits zero; an unknown
argument exits one. The retained prior red results are not rewritten.

## Accepted closed protocol

The named owner must be the one matching declaration kind, in the configured
owner file, directly exported at module top level. Runtime-owned declarations
cannot borrow a local/nested/default-only/ambient/type-only declaration. The
conservative grammar rejects declaration-file context, `declare`, missing
function bodies, missing variable initializers and const enums for runtime
ownership. Interface/type metadata may be owned but cannot satisfy a runtime
consumer edge. This proves a declaration-shaped named runtime owner, not the
executability or value/type correctness of its initializer/body.

The conservative reserved-name census includes object/array/rest bindings,
parameters, named function/class expressions, quoted/static-string-computed
methods, fields and accessors. Renamed binding keys remain distinct from local
names. Carrier fingerprints retain complete VariableStatement envelopes,
including export visibility, declaration-list mutability and companion
declarations. The intentional printer normalization still ignores comments and
whitespace. It is a closed source fingerprint, not semantic equivalence or a
compiler-output attestation.

Each runtime consumer edge names a configured runtime-owned symbol and belongs
to its exact profile roots. Named owned-symbol runtime imports need the
canonical relative owner path and an exact listed edge, including otherwise
unknown relative imports. The finite literal path grammar supports extensionless
`.ts` and `.js/.ts`, `.mjs/.mts`, `.cjs/.cts` counterparts. Direct owner
namespace/default/side-effect, literal dynamic/require/import-equals and owner
re-export forms refuse; future compatibility requires an explicit new reviewed
profile/protocol. Lexical references bind to the actual import symbol; erased
type references do not replace runtime value references. Duplicate
symbols/edges/carriers refuse. Runtime reference counting is not control-flow,
reachability, interprocedural use or authority proof.

Filesystem reading stays bounded to configured real directory segments and
runtime TypeScript source files. Source-file symlinks are not followed, and a
symlinked required owner/consumer cannot stand in for missing source. Synthetic
filesystem tests exercise that protocol. This is not TOCTOU/OS isolation,
permission or arbitrary filesystem/module-resolution assurance.

## Current-profile and scope preservation

The existing profile protects only `DOCUMENT_TYPES` and `TEMPLATE_KEY_BY_TYPE`
in `apps/api-strategy/src/context/frontmatter.ts`, four runtime binding roles in
three unchanged consumer services, and the two complete vocabulary declaration
fingerprints. Report metadata conversion and all other application facade/
registry conversions remain pending. No new runtime registry/service/store,
handler, carrier, HTTP/DTO/schema/migration or provider path is introduced.

Exactly five non-doc paths differ from PR2412: guard implementation, inert
tests, JSON profile, root package alias and CI step. All `apps/**` and
`packages/**` source is unchanged. All 168 current-profile source blobs match
both accepted source and frozen PR2412; five root source hashes also match
accepted source, for 173 recorded input hashes. JSON/package/CI bytes are
identical to their reviewed `721bfd482` versions. Static wiring points once to
the package alias; its two exact Node commands were exercised separately.

The source strings are data only. The review executes guard/compiler code,
inert controls and bounded source-reading CLI behavior. It imports no application
module and invokes no actual owner, provider, message, upload, model, DB,
migration, credential/permission, AWS or network operation. No native Prisma
download/generation, emit of application source, main merge or deployment runs.

Root reported a pnpm alias launcher failure during automatic dependency/store
synchronization (`ENOENT`) before installation. It was not retried or bypassed
by this reviewer. Direct Node command acceptance does not qualify that launcher,
the clean configured Node22/pnpm9.12 install, CI execution, native generation or
full Cleanup/Wave gates. Those, real PostgreSQL/RLS/MVCC/concurrency and deployed
behavior remain open. No arbitrary differently named copy, dynamic alias,
module side-effect/value execution, runtime type compatibility, module graph,
OS/runtime/security or customer-data behavior claim follows from this guard.

## Retained evidence

Initial review at `9c7bd2de8` remains immutable: 31 original author passes and
17 red expectations in the 24-case independent corpus. The `721bfd482` review
retains original 24 passing, 65 author passing and the additional three import
and four ambient reds. Exact initial/intermediate corpus files and checksum
manifests remain unchanged. Final runners differ only in head/tree metadata and
new output filenames; all 55 vector bodies remain exact.

Final command receipts and raw outputs are `evidence/final-*.{command.json,txt}`.
`final-preservation.json` records original-name and corpus-body retention;
`final-source-manifest.json` binds all 173 source inputs. The final curated
checksum manifest covers the complete retained packet, excluding itself.
Independent changes are evidence/docs only. Parent ownership coordination
still holds the four proposed application extractions, including Meri dispatch.
