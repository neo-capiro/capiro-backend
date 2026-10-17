# Fixed Objective decision raw HTTP capture

Core-only successor to PR70 `7b39d341f2a5300f37b0a9aab4899fc3dab3ccf3`,
tree `1fdaff4b09fffd6f051d3c78eb7e3926e8da79fb`. This closes that source's
missing original-byte bootstrap capture. It does not enable issuing authority.
The coordinator allocated these narrow main/bootstrap/helper/spec paths after
Core cleanup confirmed no overlap. Core received the exact changed-file list.

## Transport boundary

Only main.ts opts in to `includeObjectiveDecisionRawBody`. The optional shared
HTTP configuration flag defaults to false; engagement-main and every existing
caller that omits it retain their ordinary parser chain. No global Nest
`rawBody:true` or `bodyParser:false` option is introduced.

The handler runs before the existing JSON parser and matches only literal
`POST /api/internal/objective-workload-authority/decisions`, using the unchanged
original URL including any query. It requires exactly one original JSON
Content-Type header, optionally declaring UTF-8/utf8 with or without quotes.
Unknown parameters, other charsets and other media types are refused. Repeated
Content-Type or Content-Encoding headers are refused before parsing. Only absent
or identity Content-Encoding is accepted, and the binary parser also has
`inflate:false`. The transport never hashes decompressed or reserialized data.

The binary parser limits the entity to **4096 bytes**, matching the closed
issuance ingress. Its verify hook creates an independent Buffer copy in an own,
nonenumerable, nonwritable, nonconfigurable `rawBody` data property. The parser's
`request.body` Buffer is a separate object. Captured bytes can include invalid
JSON, invalid UTF-8, duplicate keys or a BOM; capture is not interpretation or
authorization. The existing ingress independently snapshots and validates exact
canonical UTF-8 bytes before its first await and verifies the caller proof.

The existing controller still rejects duplicate original Authorization headers
even when Node normalizes/discards their duplicate values. That executable
guard is unchanged. Neither parsed request.body nor an accessor is promoted to
signed entity bytes. The production admission module still calls the same
zero-argument disabled runtime factory, with no key/environment discovery or
enablement switch.

Queries, case variants, trailing slashes, encoded aliases, absolute-form targets
and other methods receive no raw capture. Any router-accepted alias remains
closed at the controller/ingress. Such aliases retain the ordinary JSON limit;
the 4096-byte capture ceiling applies to the literal canonical POST only.
Malformed framing can also be refused by Node before Express receives it.

Canonical parser failures return 400 for ambiguous content headers, 415 for
unsupported content metadata and 413 for excess bytes. They carry no-store /
no-cache plus the existing CORS and configured identity headers. Requests
reaching the production disabled controller continue to return the existing
generic 503. No raw entity or credential is returned by production middleware.

## HTTP qualification

The focused fixture uses actual NestFactory.create, the actual shared
configureApiHttpApp before app.init/listen, Nest's normal automatic parser
registration, the actual admission controller and native Node HTTP requests to
an ephemeral loopback server. Explicit synthetic runtime observers inspect only
the transport boundary; their positive responses are not issuance successes.
A separate app imports the actual ObjectiveWorkloadAdmissionModule and checks
its production-disabled response. Full AppModule/database/auth-provider startup
is excluded; this qualifies the actual HTTP parser chain, not live authority.

Node24.19.0: **129/129 tests across five suites passed**, including 59 actual
HTTP parser cases and 70 existing bootstrap/admission regressions. The gate
exited naturally with `--detectOpenHandles` and no open-handle report. Scoped
strict TypeScript and whitespace checks passed. Independent source review
accepted the exact-route/header/encoding/byte-limit and parser-order boundary;
the final staged candidate receives exact-tree review before publication.

HTTP cases include Unicode split across chunks, duplicate JSON keys, invalid
JSON/UTF-8/BOM, exact 4096 and excess 4097 bytes, duplicate original headers,
compression/charset rejection, literal URL aliases, empty-body production
closure, and a truncated Content-Length entity ending with native FIN before
capture. Ordinary JSON retains decompression and its 1 MiB ceiling; forms,
all three 1 MiB webhook parsers, and the 32 MiB email-signature parser/opt-out
remain covered.

Portable commands with Node24 and existing locked dependencies:

```powershell
node apps/api/node_modules/jest/bin/jest.js --config docs/objective-strategy-core-20261017/qualification/admission-raw-http.jest.cjs --runInBand --detectOpenHandles
node apps/api/node_modules/typescript/bin/tsc -p docs/objective-strategy-core-20261017/qualification/admission-raw-http.tsconfig.json --noEmit
```

The source changes only main's capture flag, shared HTTP configuration, the new
fixed handler/HTTP spec, the controller's stale capture-status comment, and
these scoped qualification files. No executable controller, admission provider,
Clerk/session/tenant authority, ordinary route, timeout, migration, Meri source,
shipping pin, dependency, image build, AWS, credential, deployment or live
activation changes. Genuine Core authority/credential bindings and Fable's
sealed, unqualified custody/composition remain required. No native SQL is run.
