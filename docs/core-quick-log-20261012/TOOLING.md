# Local tooling diagnosis

Prisma 5.22.0's official pinned engine checksum URLs on `binaries.prisma.sh`
were probed through the environment's normal network path. Both schema-engine
and libquery-engine requests failed with curl exit 56, `CONNECT tunnel failed,
response 403`, and target HTTP status `000`. The returned CONNECT response is
from Envoy. Rejection occurred before TLS to Prisma's origin; this is an
environment proxy/access-policy restriction, not evidence of an upstream Prisma
HTTP failure. The exact allowlist rule is not exposed by this response.

Smallest supported remedy: the environment owner authorizes normal HTTPS CONNECT
to `binaries.prisma.sh:443`, then reruns the repository-pinned Prisma generation
with normal checksum verification. This work neither changes network policy nor
uses an alternate host, engine binary, proxy or checksum bypass. Official Prisma
WASM schema validation and no-engine client generation support local compilation;
they do not qualify native Prisma/PostgreSQL runtime behavior.

ESLint is a separate repository dependency/configuration gap. Main
`4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace` and Cleanup2392
`03d85a40e390f8f52614aab20427a3a9433786bb` both define API/Strategy lint scripts
invoking eslint, but neither root nor either package declares ESLint, a TypeScript
ESLint parser/plugin, or a config package. No ESLint configuration or lockfile
entry was found. The frozen/offline install succeeds; `pnpm run lint` still fails
because `eslint` is not found. It is not an install allowlist failure.

Smallest supported remedy: a separately reviewed tooling change must add pinned
compatible ESLint/TypeScript parser/plugin/config dependencies and a configuration,
update the lockfile, and establish the baseline. A global install or suppressing
the missing command is not a qualification result. No shared configuration or
Cleanup branch was changed here. Raw proxy and manifest receipts are included in
the evidence bundle; no proxy credentials or environment secrets are recorded.
