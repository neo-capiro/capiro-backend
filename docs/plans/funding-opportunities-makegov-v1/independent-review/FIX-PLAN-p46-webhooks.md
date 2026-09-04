# Fix plan — P46 Tango webhook receiver: F1 (permanent delivery loss) and F2 (forgeable replay defense)

**Status:** PLANNED — nothing in this document has been implemented. No source file, test file,
migration, or schema file has been modified. This is a plan for a future engineer/agent to execute.

**Scope:** Exactly the two bugs below. Several *other* real defects exist in the same file
(bare-hex signature rejection, untested HTTP path, tests that re-implement the signing algorithm,
etc.) — see [§7](#7-explicitly-out-of-scope) for the full list and why they are deliberately not
touched here.

**Verified against:** `origin/main` at `3e2a691baa2a94802047ded1c3fe7a5dfd4e366c` (fetched
2026-08-14; merge PR #955, `feat(directory): give vNext member profiles the same depth as
canonical`). Confirmed by `git log d800dcfde5..origin/main -- apps/api/src/webhooks/
apps/api/src/external/tango/ apps/api/prisma/migrations/
apps/api/scripts/diag-tango-webhook-contract.ts apps/api/prisma/schema.prisma package.json` that
**zero commits touched any relevant path** between the prior independent review's commit
(`d800dcfde5`) and the current tip — so every quote below is simultaneously "what
`band-a-p46-webhooks.md` reviewed" and "what is on main today."

**Method:** Read-only. All Capiro source was read via `git show origin/main:<path>` against
`C:\dev\capirov2`; its working tree (which has unrelated uncommitted changes on
`agent/fo-p36-outcome-capture`) was never touched. The vendor SDK was read directly off disk at
`C:\dev\capirov2\node_modules\.pnpm\@makegov+tango-node@1.1.0\node_modules\@makegov\tango-node`
— the exact version pinned in `apps/api/package.json` (`"@makegov/tango-node": "1.1.0"`, exact
pin, no range). No network call, no database write, no file in either repo was modified.

---

## TL;DR

- Both bugs are confirmed present, verbatim, at current `origin/main`. See [§1](#1-bug-confirmation-at-current-originmain).
- The HMAC signature covers **raw request body bytes only** — confirmed directly from the vendor
  SDK's own `signing.js`, not inferred. No header, no timestamp, nothing else is signed. See [§2](#2-what-the-signature-actually-covers-verified-directly-against-the-vendor-sdk).
- The fix: stop using the unsigned `x-tango-delivery-id` header for identity at all. When the
  signed body itself names no id (which is true of **every** real payload shape the SDK
  documents), fall back to `payloadDigest(rawBody)` — the SHA-256 hex digest of the exact bytes
  the signature already verified. This is not a new primitive: `payloadDigest` already exists in
  this file and is already called once per delivery. See [§3](#3-fix-design).
- **No schema or migration change is required.** The `delivery_id` column is `TEXT` with only a
  non-empty `CHECK`, not `UUID` — a 64-character lowercase-hex digest fits it exactly as-is, and
  the table already stores this same digest in a different (non-unique) column,
  `payload_sha256`, today. See [§4](#4-schema--migration-determination).
- Touches 3 files for the core fix (`tango-webhook.service.ts`, `tango-webhook.controller.ts`,
  `tango-webhook.spec.ts`) plus one small consistency fix in a diagnostic script. See [§5](#5-implementation-steps-in-order) and [§6](#6-test-plan).

---

## 1. Bug confirmation at current `origin/main`

### 1.1 Bug 1 — every documented delivery shape is rejected `missing_delivery_id` → 400 → never retried

`apps/api/src/webhooks/tango-webhook.service.ts`, current lines 246–254:

```ts
  const deliveryId = firstNonEmptyString([
    body.delivery_id,
    body.deliveryId,
    body.id,
    deliveryHeader,
  ]);
  if (deliveryId === null) return { ok: false, rejection: 'missing_delivery_id' };
```

`missing_delivery_id` is in the `TangoWebhookRejection` union at line 66, and the controller maps
it to a terminal 4xx at `tango-webhook.controller.ts` line 118:

```ts
    case 'missing_delivery_id':
      return new BadRequestException('Missing delivery id');
```

Per the controller's own documented retry contract (its file-header doc block), 400 means
*"will never succeed as sent. Stop retrying."* — so this is permanent loss, not a delay.

**Confirmed against the pinned SDK, directly, in this session** (not re-derived from the prior
review): `@makegov/tango-node@1.1.0`'s `dist/models/Webhooks.d.ts` declares

```ts
export interface WebhookSampleDelivery {
    timestamp: string;
    events: Array<Record<string, unknown>>;
}
```

— no `delivery_id`, `deliveryId`, or `id` field. The SDK's `docs/WEBHOOKS.md` shows this exact
shape as the canonical batch body (`{ timestamp, events: [{ event_type, record }] }`) and a second,
single-event body (`{ event_type, alert_id, query_type, filters, matches, checked_at }`) — neither
carries an id field either. (`alert_id` is the *subscription* id, constant across every delivery
of that alert; it is not read by `readEnvelope` today, and must never be read as a delivery id —
see the negative assertion in the new test in [§6.3](#63-new-tests-to-add).)

So: on the provider's own published contract, the first real delivery this receiver ever gets is
answered 400 and is gone, with no row and no dead-letter — only one `warn` log line.

### 1.2 Bug 2 — the only path that ever fires is an unsigned, forgeable header

`deliveryHeader` above is bound at `tango-webhook.controller.ts` line ~68:

```ts
    @Headers(TANGO_DELIVERY_HEADER) deliveryId: string | undefined,
```

where `TANGO_DELIVERY_HEADER` (`tango-webhook.service.ts` line 49) is:

```ts
export const TANGO_DELIVERY_HEADER = 'x-tango-delivery-id';
```

This header is an ordinary HTTP header, read outside the signed bytes. Given §1.1, it is not "a
last resort for a provider that sends no id in the body at all" (the code's own comment, still
present) — it is **the only path that can ever fire for a real delivery**, because no real body
ever supplies one.

**Confirmed directly against the vendor SDK in this session:** `verifyTangoSignature` (the
function that actually runs) is:

```ts
  const expected = createHmac('sha256', secret).update(rawBody).digest();
```

— it hashes `rawBody` and nothing else; no header is mixed in. Independently, the SDK's own
`generateSignature(body, secret)` in `dist/webhooks/signing.js` is `createHmac("sha256",
secret).update(toBuffer(body)).digest("hex")` — same shape, body-only. And a
case-insensitive, whole-package grep (`docs/`, `README.md`, `dist/`) for any delivery-id header
turns up **zero hits** — the SDK documents exactly one webhook header,
`X-Tango-Signature` (`SIGNATURE_HEADER` in `signing.js`). `x-tango-delivery-id` is a Capiro
invention with no provider corroboration of any kind.

Net effect: the unique index the migration calls *"the whole replay defence"*
(`tango_webhook_delivery_delivery_id_uniq`, on column `delivery_id`) is keyed on attacker-
controlled input. Anyone who can observe one valid signed delivery (a proxy, a log, a mirrored
request) can resend the identical bytes under a new forged `x-tango-delivery-id` each time, and
today's code stores each replay as a new, distinct row — which P47/P48 would fan out into
duplicate client-facing alerts.

Both bugs are exactly as `docs/plans/funding-opportunities-makegov-v1/independent-review/band-a-p46-webhooks.md` (§3, F1/F2) described them on 2026-08-13, and nothing has changed since.

---

## 2. What the signature actually covers (verified directly against the vendor SDK)

This matters because the fix's entire security property rests on it: the replacement identity
must be derived only from bytes the signature already authenticates, or it inherits the same
forgeability as the header it replaces.

Read directly from `@makegov/tango-node@1.1.0`, `dist/webhooks/signing.js` /
`dist/webhooks/signing.d.ts` (the file's own header comment states these mirror the canonical
Python implementation and the Tango server):

- `generateSignature(body: string | Buffer, secret: string): string` — HMAC-SHA256 over `body`
  alone. No headers, no timestamp, no delivery id, nothing else is mixed into the MAC input.
- `verifySignature(body, header, secret)` parses the header into `{ algorithm, signature }` and
  compares against `generateSignature(body, secret)`. Same conclusion: body-only.
- The SDK's own troubleshooting section warns that reformatting whitespace or reordering keys
  "breaks it" — consistent with signing exact bytes, not a canonicalized/re-serialized form.

Capiro's own `verifyTangoSignature` (`tango-webhook.service.ts`, confirmed in §1.2) independently
implements the identical scheme: `createHmac('sha256', secret).update(rawBody).digest()`, called
with the `Buffer` express's raw-body parser produced — never a re-serialized object.

**Conclusion: the signed envelope is the raw body bytes, full stop.** No optional
`x-tango-timestamp` or `x-tango-delivery-id` header is, or ever was, part of what the signature
authenticates. This was independently confirmed (not merely inherited from the prior review) by
reading the SDK's actual `.js` source, not just its docs.

One consequence worth stating precisely: **the raw-bytes-before-JSON-parse ordering invariant is
a precondition for this fix, not incidental to it.** Independently re-confirmed this session at
`apps/api/src/bootstrap/configure-api-http-app.ts`:

```ts
  // 4. ...
  if (options.includeTangoRawBody) {
    app.use('/webhooks/tango', raw({ type: '*/*', limit: '1mb' }));
  }
  ...
  // 6. Default JSON parser
  app.use(json({ limit: options.defaultJsonLimit }));
```

The Tango raw-body mount (step 4) is registered before the global `json()` parser (step 6), so
`req.body` reaching the controller is the exact `Buffer` the provider sent. The fix below computes
its content digest from that same `Buffer` — the identical bytes `verifyTangoSignature` already
authenticated, not a re-derived or re-parsed form. This is why the fix introduces no new trust
assumption: the digest is exactly as trustworthy as the signature check that already gates it.

---

## 3. Fix design

### 3.1 Core idea

Stop treating `x-tango-delivery-id` as a source of identity at all. Keep checking the signed
body's own id-shaped fields first (forward-compatible: if the provider ever starts sending a real
id, it wins, because it is inside the signed bytes). When none exist — which is every real
delivery today — fall back to the SHA-256 hex digest of the exact verified raw body, computed with
the function that already exists in this file for a different column:

```ts
export function payloadDigest(rawBody: Buffer): string {
  return createHash('sha256').update(rawBody).digest('hex');
}
```

New precedence, replacing the current one:

```
OLD: body.delivery_id  →  body.deliveryId  →  body.id  →  x-tango-delivery-id header  →  400 missing_delivery_id
NEW: body.delivery_id  →  body.deliveryId  →  body.id  →  SHA-256(rawBody)  [always succeeds]
```

The header is still read off the request (unchanged controller signature) and is still logged for
operator debugging, but it never again participates in identity resolution or in the uniqueness
check. This satisfies "keep it for observability only, never as the uniqueness key" without a
schema change (see [§4](#4-schema--migration-determination) for why, and for the one optional
alternative if the team wants it durably stored per-row instead of in logs).

### 3.2 Why this closes Bug 2 (security analysis)

Attacker model: someone who can observe or replay one legitimately-signed request (a
TLS-terminating proxy, a log, a mirrored request) but does not have the signing secret, so they
can only resend bytes verbatim — they cannot mint a new valid signature for modified content.

- **Body carries no id (today's reality, 100% of real traffic per §1.1):** identity =
  `SHA-256(rawBody)`. Replaying the identical bytes under any number of different forged
  `x-tango-delivery-id` values produces the **same** digest every time, because the digest is a
  pure function of bytes the attacker cannot change (changing them invalidates the signature,
  which is checked first and rejects before identity is ever computed). Every replay after the
  first hits the same unique-index entry and is caught by the existing `P2002` handling, answered
  `duplicate`, and stores no second row. This is the exact scenario the prior review's throwaway
  script reproduced (one signed body, three forged headers, three rows allowed) — after this fix,
  the same script would show one row.
- **Body carries a real id (hypothetical future provider behavior):** identity = that id, exactly
  as today's (correct) precedence already does — unaffected by this change, still covered by the
  existing passing tests for that case.

No new trust assumption is introduced: the digest is computed from the same buffer the signature
already authenticated (§2), so its integrity is exactly as strong as signature verification
itself, which is independently and thoroughly tested (see the existing `describe('verifyTangoSignature', ...)` block — untouched by this fix).

### 3.3 Why `missing_delivery_id` disappears entirely but `missing_event_type` does not

This asymmetry is intentional, not an oversight, and should be preserved:

- An **id** is something a receiver can always synthesize a safe surrogate for from bytes it
  already possesses — any non-empty byte string has a SHA-256 digest. There is no case where a
  fallback is unavailable.
- An **event type** is semantic information the receiver cannot invent. There is no safe default
  meaning for "we don't know what kind of event this is," so failing closed with
  `missing_event_type` when no event-type-shaped key exists anywhere (top level or first batch
  event) remains correct and is **not** touched by this fix.

In practice this rejection reason should also almost never fire against real traffic, since both
of the SDK's documented shapes always carry an event type — but unlike the id case, there is no
principled fallback if they didn't, so it stays a real, reachable rejection.

### 3.4 The "legitimate content repeat" design tension — and why it resolves safely

The migration's own comment (quoted in full in §4) states a deliberate design assumption: *"the
same content legitimately arrives under different delivery ids (the provider re-emitting after its
own retry window)"* — i.e., it assumed `delivery_id` would be a real, independent-of-content
identifier, so that two genuinely different deliveries could safely share identical `payload_sha256`
values without colliding. Keying identity on content hash instead puts pressure on exactly this
assumption: if two truly distinct (non-retry) deliveries ever produced byte-identical bodies, the
second would be misclassified as a duplicate and silently dropped.

This is a narrower risk than it first appears, because both documented body shapes carry a
timestamp field **inside the signed bytes**:

- The batch shape carries a top-level `timestamp`.
- The single-event shape carries `checked_at`.

Since the digest is computed over the *entire* raw body, any variation in that timestamp between
two genuinely distinct deliveries (which is the normal case — a batch sent five minutes later has
a different `timestamp`) already produces a different digest, correctly treating them as distinct.
A **true** provider retry of the same delivery attempt resends byte-identical bytes, including the
same timestamp — correctly collapsing to the same digest and the same `duplicate` outcome. The
failure mode only exists if the provider could ever emit two *distinct* deliveries with an
identical timestamp field down to the value it serializes *and* identical event content — flagged
explicitly as an open question in [§8](#8-open-questions-provider-input--live-data-does-not-block-this-fix), not resolved here, and strictly narrower and safer than either of today's two bugs (total loss, or unlimited forgeable duplication).

---

## 4. Schema / migration determination

**No schema or migration change is required.** Verified directly:

`apps/api/prisma/migrations/20260905010000_tango_webhook_deliveries/migration.sql`:

```sql
CREATE TABLE IF NOT EXISTS "tango_webhook_delivery" (
  "id"                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  "delivery_id"        TEXT NOT NULL,
  ...
  "payload_sha256"     TEXT NOT NULL,
  ...
);
...
ALTER TABLE "tango_webhook_delivery"
  ADD CONSTRAINT "tango_webhook_delivery_delivery_id_chk"
  CHECK (btrim("delivery_id") <> '');
...
CREATE UNIQUE INDEX IF NOT EXISTS "tango_webhook_delivery_delivery_id_uniq"
  ON "tango_webhook_delivery" ("delivery_id");
```

`delivery_id` is `TEXT`, not `UUID`, with only a non-empty `CHECK` — no length limit, no format
constraint. A 64-character lowercase-hex SHA-256 digest is trivially valid input; it is not even a
new *kind* of value for this table, since `payload_sha256` (same table, same migration) already
stores exactly this value today, computed by the same `payloadDigest()` function, under the
constraint `CHECK ("payload_sha256" ~ '^[0-9a-f]{64}$')`. The Prisma model
(`apps/api/prisma/schema.prisma`, model `TangoWebhookDelivery`, around line 6514–6518) mirrors
this: `deliveryId String @unique(...) @map("delivery_id")` — a plain `String`, no `@db.Uuid`
or length attribute (contrast with `id String @id @default(uuid()) @db.Uuid` two lines above it,
which *is* UUID-typed — `delivery_id` deliberately is not).

**Practical implication:** the fix is a pure application-logic change. Writing
`payloadDigest(rawBody)` into the same `deliveryId` field that used to receive the header value
requires zero migration work — it is the same column, same type, same constraint, just a
different source value at the call site.

Two secondary, explicitly optional points:

1. **Schema/migration doc-comment sync (optional, no DB change).** The `///` doc comment above
   `deliveryId` in `schema.prisma` currently frames the header as a real fallback ("A provider
   retry ... hits the unique index"). Updating this comment to describe the new content-digest
   fallback is good hygiene but is a comment-only edit — Prisma does not regenerate SQL from `///`
   comments (the `COMMENT ON TABLE` in the migration file was hand-written, not tool-generated;
   there is no column-level `COMMENT ON COLUMN` anywhere in this migration to keep in sync). Doing
   this does **not** require a new migration file. Purely optional; do not let it block the fix.
2. **Optional additive column for durable per-row header forensics.** If the team wants the raw
   `x-tango-delivery-id` value queryable from the database later (beyond whatever log retention
   window exists) rather than only in structured logs (the default recommendation in [§5.1](#51-tango-webhookservicets-core-fix)), a new nullable, non-indexed, non-unique column
   (e.g., `provider_delivery_header TEXT NULL`) could be added in a small new migration, written
   with the same `IF NOT EXISTS`/`DO $$...$$` guard style as the existing one. This is **not**
   required for correctness or for closing F1/F2, and is not part of the core fix below — flagged
   here only because it is the literal reading of "keep it in the stored row," in case the team
   prefers it to logging.

---

## 5. Implementation steps, in order

### 5.1 `tango-webhook.service.ts` (core fix)

**Change 1 — remove the now-impossible rejection reason.** Line 66, delete the union member:

```ts
export type TangoWebhookRejection =
  | 'not_configured'
  | 'missing_body'
  | 'missing_signature'
  | 'malformed_signature'
  | 'invalid_signature'
  | 'malformed_json'
- | 'missing_delivery_id'
  | 'missing_event_type'
  | 'stale_timestamp';
```

Recommended: remove it outright rather than leave it as an unreachable member. TypeScript will
then flag the controller's now-invalid `case 'missing_delivery_id':` as a compile error (no
`default:` clause in that switch), which is a useful forcing function to make sure Change 4 below
isn't missed. (If the team prefers defensive headroom over a clean union, keeping the member but
provably unreachable is an acceptable alternative — but the recommendation is to remove it.)

**Change 2 — `readEnvelope`'s signature and identity resolution.** Current, lines 195 and
246–254:

```ts
export function readEnvelope(
  payload: unknown,
  deliveryHeader: string | undefined,
  providerEventAt: Date | null,
): TangoEnvelopeResult {
  ...
  const deliveryId = firstNonEmptyString([
    body.delivery_id,
    body.deliveryId,
    body.id,
    deliveryHeader,
  ]);
  if (deliveryId === null) return { ok: false, rejection: 'missing_delivery_id' };
```

New:

```ts
export function readEnvelope(
  payload: unknown,
  contentDigest: string,
  providerEventAt: Date | null,
): TangoEnvelopeResult {
  ...
  // THE SIGNED BODY WINS, and now it is the ONLY thing that can. The HMAC
  // covers the body only (verified against the vendor SDK's own signing.js —
  // see FIX-PLAN-p46-webhooks.md §2), so any header is attacker-controlled and
  // is no longer part of identity resolution at all — not even as a last
  // resort. When the body names no id (true of every shape the provider's SDK
  // documents today), the fallback is the SHA-256 digest of the exact verified
  // bytes: a value an attacker cannot change without invalidating the
  // signature, and one that is always available, so this can never fail.
  const deliveryId =
    firstNonEmptyString([body.delivery_id, body.deliveryId, body.id]) ?? contentDigest;
```

Delete the `if (deliveryId === null) return { ok: false, rejection: 'missing_delivery_id' };` line
— `deliveryId` can no longer be null (`contentDigest` is a required, always-populated `string`,
never `undefined`), so the branch is unreachable and should not be kept as dead code. Also update
the two doc comments inside this function that currently describe the header as "a last resort" —
rewrite them to describe the content-digest fallback using the paragraph above as a base; the
exact wording is an implementer's call, but it must no longer claim the header participates in
identity.

**Change 3 — `receive()`: compute the digest once, thread it through, reuse it.** Current,
relevant lines 363–393:

```ts
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString('utf8'));
    } catch {
      this.logger.warn('Tango webhook rejected: malformed_json');
      return { kind: 'rejected', rejection: 'malformed_json' };
    }

    const envelope = readEnvelope(parsed, headers.deliveryId, window.providerEventAt);
    if (!envelope.ok) {
      this.logger.warn(`Tango webhook rejected: ${envelope.rejection}`);
      return { kind: 'rejected', rejection: envelope.rejection };
    }

    const { deliveryId, eventType, eventId, providerEventAt } = envelope.envelope;
    try {
      await this.prisma.tangoWebhookDelivery.create({
        data: {
          deliveryId,
          eventType,
          eventId,
          payloadSha256: payloadDigest(rawBody),
          payloadBytes: rawBody.byteLength,
          payload: parsed as never,
          status: 'received',
          providerEventAt,
        },
      });
```

New (insert the digest computation right after JSON parsing succeeds; pass it into `readEnvelope`
in place of `headers.deliveryId`; reuse the same value at insert time instead of hashing twice; add
an observability-only log of the raw header):

```ts
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString('utf8'));
    } catch {
      this.logger.warn('Tango webhook rejected: malformed_json');
      return { kind: 'rejected', rejection: 'malformed_json' };
    }

    // Computed once, from the exact bytes verifyTangoSignature already
    // authenticated. Reused below both as the id-resolution fallback and as
    // the stored payloadSha256 — one hash, two uses, so the two values are
    // provably the same computation, not two independent calls that could
    // drift.
    const contentDigest = payloadDigest(rawBody);

    const envelope = readEnvelope(parsed, contentDigest, window.providerEventAt);
    if (!envelope.ok) {
      this.logger.warn(`Tango webhook rejected: ${envelope.rejection}`);
      return { kind: 'rejected', rejection: envelope.rejection };
    }

    // Observability only. x-tango-delivery-id is NOT part of the HMAC (§2 of
    // FIX-PLAN-p46-webhooks.md) and MUST NEVER influence identity or the
    // uniqueness check — an attacker replaying a captured signed body can set
    // this to anything. Logged, never stored, never compared.
    if (headers.deliveryId !== undefined && headers.deliveryId.trim() !== '') {
      this.logger.debug(
        `Tango webhook: ${TANGO_DELIVERY_HEADER}="${headers.deliveryId.trim()}" received ` +
          `(unsigned; ignored for identity). Resolved identity=${envelope.envelope.deliveryId}`,
      );
    }

    const { deliveryId, eventType, eventId, providerEventAt } = envelope.envelope;
    try {
      await this.prisma.tangoWebhookDelivery.create({
        data: {
          deliveryId,
          eventType,
          eventId,
          payloadSha256: contentDigest,
          payloadBytes: rawBody.byteLength,
          payload: parsed as never,
          status: 'received',
          providerEventAt,
        },
      });
```

Nothing else in `receive()` changes. `headers.deliveryId` stays in the method's parameter type
(still needed for the new log line); the controller's binding of `TANGO_DELIVERY_HEADER` is
untouched.

### 5.2 `tango-webhook.controller.ts`

**Change 4 — delete the dead switch case.** In `rejectionToHttp` (line 104 `switch (rejection)`),
delete lines 118–119:

```ts
-    case 'missing_delivery_id':
-      return new BadRequestException('Missing delivery id');
```

No other change to this file. `TANGO_DELIVERY_HEADER` is still imported and still bound via
`@Headers(...)` — it still flows into `service.receive()`'s `headers.deliveryId`, now purely for
the observability log added in Change 3.

### 5.3 `tango-webhook.spec.ts`

See [§6](#6-test-plan) for the full enumeration — listed separately because it is large enough to
need its own structure (which tests change behaviorally vs. which need a purely mechanical
call-site fix vs. which are new).

### 5.4 `apps/api/scripts/diag-tango-webhook-contract.ts` (required consistency fix, small)

Not one of the two bugs, but directly stale once Change 2 lands: this diagnostic's `consequence`
string for the `'a delivery id is findable in the body'` finding currently says (line ~117):

```ts
    consequence:
      'Without one, the receiver falls back to the delivery header. If the provider sends neither, every delivery is refused `missing_delivery_id` — so confirm the header is sent.',
```

Both claims in that sentence become false once the fix lands: the receiver no longer falls back to
the header, and it can no longer refuse `missing_delivery_id` (the rejection reason no longer
exists). Leaving this unedited would make the one tool whose job is telling an operator the truth
assert something false about the exact fact this fix changes — the same failure class the prior
review's F5 flagged in this same script. Replace with something like:

```ts
    consequence:
      'Without one, the receiver falls back to a SHA-256 digest of the verified body, so the delivery is still recorded — this is informational, not a failure mode, as of FIX-PLAN-p46-webhooks.md.',
```

This is a **string-only** change to the `consequence` field; `agrees`/`actual`/`expected` computation
is untouched, so — confirmed by reading `diag-tango-webhook-contract.spec.ts` directly — none of
its existing tests assert on this specific `consequence` string (they assert `.agrees` and
`.actual` for this finding; the one test that does check `.consequence` text,
`'DIFFERS when no known event-type key appears anywhere'`, checks the **event-type** finding's
consequence, a different string, untouched). No test changes needed in that spec file; re-run it
anyway as part of [§9](#9-rollout--verification-checklist).

### 5.5 Order of execution

1. `tango-webhook.service.ts` (Changes 1–3) — do this first; the compiler will immediately flag
   every other file that needs a matching change.
2. `tango-webhook.controller.ts` (Change 4) — TypeScript should already be erroring here after
   step 1; fix it.
3. `tango-webhook.spec.ts` — TypeScript should now be erroring on every `readEnvelope(...)` call
   site that passes `undefined` as the second argument (type changed from `string | undefined` to
   `string`); fix per [§6](#6-test-plan).
4. `diag-tango-webhook-contract.ts` — no compiler dependency on the above; independent one-string
   edit, do it whenever convenient.
5. Run the test subset in [§9](#9-rollout--verification-checklist).

---

## 6. Test plan

`tango-webhook.spec.ts` calls `readEnvelope(payload, secondArg, providerEventAt)` at every one of
the sites below. Changing the second parameter's type from `string | undefined` to `string` means
every call currently passing `undefined` will fail to compile, regardless of whether that
particular test's *assertion* needs to change. Recommend adding one shared constant near the top
of the file (next to `const SECRET = ...`) to make this mechanical and consistent:

```ts
// Stand-in for payloadDigest(rawBody) in unit tests that exercise a code path
// where the body already supplies its own id, so the digest fallback is never
// actually read. Using a fixed, obviously-synthetic value (not a real digest
// of anything) keeps those tests' intent clear.
const PLACEHOLDER_DIGEST = '0'.repeat(64);
```

### 6.1 Existing tests whose expected OUTCOME changes

| Line (current) | Test | Old expectation | New expectation |
|---|---|---|---|
| 238 | `'falls back to the header ONLY when the body carries no id'` | `readEnvelope({ event_type: 'opportunity.updated' }, 'from-header', null)` → `deliveryId === 'from-header'` | Rename to `'falls back to the content digest when the body carries no id'`. Call `readEnvelope({ event_type: 'opportunity.updated' }, PLACEHOLDER_DIGEST, null)` → `envelope.deliveryId === PLACEHOLDER_DIGEST`. This replaces the header-fallback behavior with the digest-fallback behavior it now is. |
| 269–272 | `'rejects a payload with no delivery id anywhere'` | `readEnvelope({ event_type: 'x' }, undefined, null)` → `{ ok: false, rejection: 'missing_delivery_id' }` | This scenario can no longer fail. Either delete this test (its case is now covered by the renamed test above) or repurpose it as an explicit "never fails on id absence" assertion: `readEnvelope({ event_type: 'x' }, PLACEHOLDER_DIGEST, null)` → `{ ok: true, envelope: { deliveryId: PLACEHOLDER_DIGEST, eventType: 'x', eventId: null, providerEventAt: null } }`. |
| 283–286 | `'rejects a non-object payload (array) that carries no header id'` | `readEnvelope([1, 2, 3], undefined, null)` → `{ ok: false, rejection: 'missing_delivery_id' }` | Rename to `'a non-object payload (array) falls back to the digest for identity, but still fails closed on event type'`. Call `readEnvelope([1, 2, 3], PLACEHOLDER_DIGEST, null)` → `{ ok: false, rejection: 'missing_event_type' }` (id resolution now succeeds via the digest; the array still supplies no event type, so it fails closed there instead). |
| 367–370 | `'a batch with no usable event still fails CLOSED'` | `readEnvelope({ events: [{ nothing: true }] }, undefined, null)` → `{ ok: false, rejection: 'missing_delivery_id' }` | Keep the test, update body: `readEnvelope({ events: [{ nothing: true }] }, PLACEHOLDER_DIGEST, null)` → `{ ok: false, rejection: 'missing_event_type' }`. Update the comment above it (currently frames the failure as an id problem; it is now purely an event-type problem, per §3.3). |
| ~603 | Controller `it.each` table, row `['missing_delivery_id', BadRequestException]` | Asserted this rejection maps to 400 | **Delete this row.** `'missing_delivery_id'` is no longer a member of `TangoWebhookRejection`; TypeScript will reject the table literal if this row is left in. |

### 6.2 Existing tests needing a mechanical-only call-site fix (no assertion change)

These pass `undefined` (or, in one case, an array containing `undefined`) as the second argument
to `readEnvelope`, but the body already supplies a real id, so the fallback path is never actually
exercised — replace `undefined` with `PLACEHOLDER_DIGEST` purely to satisfy the new required
`string` parameter type. Lines (current): **231** (replace the `undefined` entry inside the
`['FORGED-a', 'FORGED-b', undefined]` array with `PLACEHOLDER_DIGEST`), **245**, **257**, **276**,
**290**, **304**, **322**, **346**, **352**, **358**. No expected-value changes at any of these
sites.

Two of these are worth a comment/title touch-up for accuracy even though the assertion is
unchanged, since they currently talk about "the header":

- Line 218 `'prefers the SIGNED BODY id over the unsigned header'` — still true and still a good
  test (body-level id beats *any* second argument, including the digest fallback now), but rename
  to `'prefers the SIGNED BODY id over the content-digest fallback'` for accuracy.
- Line 231 `'a replayed signed body cannot be multiplied by varying the header'` — still valid
  (body already has an id, so the second argument never matters), rename to something like `'a
  signed body's identity is unchanged no matter what the second argument is, once the body names
  its own id'`.
- Line 336 `'still prefers the SIGNED event id over the unsigned header'` — same treatment,
  rename to `'... over the content-digest fallback'`.

### 6.3 New tests to add

**(a) The end-to-end case the user explicitly asked for: a real-shaped delivery with no
body-level id must now succeed**, in `describe('TangoWebhookService.receive', ...)`:

```ts
it('records a real SDK-shaped BATCH delivery with no id anywhere, using the content digest as identity', async () => {
  const { service, prisma } = makeService({ secret: SECRET });
  // Exact shape of @makegov/tango-node's WebhookSampleDelivery / the
  // docs/WEBHOOKS.md "Test my handler in a unit test" example — {timestamp,
  // events}. No delivery_id / deliveryId / id anywhere, at any level.
  const realShaped = {
    timestamp: '2026-08-08T00:00:00Z',
    events: [{ event_type: 'alerts.contract.match', record: { piid: 'ABC123' } }],
  };
  const body = Buffer.from(JSON.stringify(realShaped));

  const outcome = await service.receive(body, {
    signature: sign(body),
    timestamp: undefined,
    deliveryId: undefined, // no x-tango-delivery-id header either
  });

  expect(outcome).toEqual({ kind: 'recorded', deliveryId: payloadDigest(body) });
  expect(prisma.rows).toHaveLength(1);
  expect(prisma.rows[0]).toMatchObject({
    deliveryId: payloadDigest(body),
    payloadSha256: payloadDigest(body),
    eventType: 'alerts.contract.match',
  });
});

it('records a real SDK-shaped SINGLE-EVENT delivery with no id, and never reads alert_id as a delivery id', async () => {
  const { service, prisma } = makeService({ secret: SECRET });
  // Exact shape of docs/WEBHOOKS.md "Generating signatures (for testing)".
  const realShaped = {
    event_type: 'alerts.entity.match',
    alert_id: 'alert_123', // the SUBSCRIPTION id — constant across deliveries; must not become the delivery identity
    query_type: 'entity',
    filters: { uei: 'ABC123' },
    matches: { new: [], modified: [], new_count: 0, modified_count: 0 },
    checked_at: '2024-01-01T00:00:00Z',
  };
  const body = Buffer.from(JSON.stringify(realShaped));

  const outcome = await service.receive(body, {
    signature: sign(body),
    timestamp: undefined,
    deliveryId: undefined,
  });

  expect(outcome).toEqual({ kind: 'recorded', deliveryId: payloadDigest(body) });
  expect(prisma.rows[0]?.deliveryId).not.toBe('alert_123');
});
```

**(b) The replay-defense regression test the user explicitly asked for: a byte-identical replay
under a different forged header must now be a duplicate, not a new row** — this is the direct,
permanent regression test for F2 / Bug 2, turning the prior review's throwaway reproduction script
into a real test:

```ts
it('treats a byte-identical replay under a DIFFERENT forged x-tango-delivery-id header as a duplicate, not a new delivery', async () => {
  const { service, prisma } = makeService({ secret: SECRET });
  const realShaped = {
    timestamp: '2026-08-08T00:00:00Z',
    events: [{ event_type: 'alerts.contract.match', record: { piid: 'ABC123' } }],
  };
  const body = Buffer.from(JSON.stringify(realShaped));
  const signature = sign(body);

  const first = await service.receive(body, {
    signature,
    timestamp: undefined,
    deliveryId: 'forged-1', // attacker/proxy-supplied, unsigned
  });
  const second = await service.receive(body, {
    signature,
    timestamp: undefined,
    deliveryId: 'forged-2', // different forged header, IDENTICAL bytes + signature
  });

  expect(first).toEqual({ kind: 'recorded', deliveryId: payloadDigest(body) });
  expect(second).toEqual({ kind: 'duplicate', deliveryId: payloadDigest(body) });
  expect(prisma.rows).toHaveLength(1); // the regression guard for F2
  expect(prisma.createCalls).toBe(2); // both attempts genuinely reached the unique index
});
```

**(c) Recommended, not required — strengthens (a) using the vendor SDK's own signer**, addressing
the adjacent (but out-of-scope, see §7) F7 concern that this spec file re-implements the signing
algorithm it tests rather than proving interop:

```ts
import { generateSignature } from '@makegov/tango-node';
// ... in a test:
const sdkSignature = generateSignature(body, SECRET); // instead of the local sign() helper
```

This is optional polish on the two new tests above, not a requirement of this fix — flagged so
whoever implements this can decide, without it blocking the core fix.

### 6.4 Nothing else in `tango-webhook.spec.ts` needs to change

Every test under `describe('verifyTangoSignature', ...)` and `describe('isWithinReplayWindow',
...)` is untouched — this fix does not change signature verification or replay-window logic. The
`describe('TangoWebhookService.receive', ...)` tests that already use a body with a real
`delivery_id` (the large majority of that block, including `'answers duplicate on exact replay...'`
and `'distinguishes same content under two delivery ids from a true replay'`) are unaffected: body-
level ids still win, unchanged.

### 6.5 `diag-tango-webhook-contract.spec.ts`

No test changes needed (confirmed directly — see §5.4). Re-run it as part of §9 to be sure.

---

## 7. Explicitly out of scope

The independent review at `docs/plans/funding-opportunities-makegov-v1/independent-review/band-a-p46-webhooks.md` found ten other issues in this same file and its neighbors. None of them are
touched by this plan; do not read this document as a full fix for P46:

- **F3 (P1)** — the receiver rejects a bare-hex `X-Tango-Signature` value that the SDK's own
  `parseSignatureHeader` accepts for legacy compatibility.
- **F4 (P1)** — the SDK's exported `SIGNATURE_HEADER`/`SIGNATURE_PREFIX` constants are never
  asserted against in code, only manually cross-checked by review.
- **F5 (P2)** — beyond the one stale string fixed in §5.4, `diag-tango-webhook-contract.ts`'s
  `KNOWN_ID_KEYS` list still independently duplicates (and is not derived from) the receiver's own
  key list, and its envelope-shape check is hardcoded `agrees: true`.
- **F6 (P2)** — no test drives the real HTTP path (raw-body middleware mount, header binding)
  end-to-end; all controller tests construct the controller directly with a stubbed service.
- **F7 (P2)** — addressed only optionally, for the two new tests, in §6.3(c); the rest of the file
  still re-implements HMAC signing locally rather than using the SDK's `generateSignature`.
- **F8 (P3)** — the 1 MB raw-body cap has not been sized against a realistic `matches`-bearing
  payload.
- **F9 (P3)** — the global `ThrottlerGuard` applies to this route undeclared.
- **F10 (P2)** — no live payload has ever reached this receiver; `diag-tango-webhook-contract` has
  never been run against a real key.
- **F11 (P3)** — a `\u0000` in an authenticated payload would loop the persistence retry forever
  (jsonb rejects it, producing a non-`P2002` error that is correctly rethrown but never resolves).
- **F12 (P4)** — `checked_at` (the single-event shape's timestamp field) is not in
  `readEnvelope`'s body-timestamp candidate list, so `provider_event_at` is null for that shape.

These remain a legitimate backlog; this plan intentionally does not expand into them.

---

## 8. Open questions: provider input / live data (does not block this fix)

None of these need to be resolved before implementing §5–§6. The content-hash approach is a
complete, correct fix for F1 and F2 without them. Recorded here per the request to flag anything
that would need MakeGov's input or a live capture, without blocking on it:

1. **Can two genuinely distinct (non-retry) deliveries ever be byte-identical?** Per §3.4, this
   would require the provider's `timestamp`/`checked_at` field (and every other body field) to
   collide exactly between two unrelated deliveries — narrow, and strictly safer than either
   current bug, but not something that can be proven offline. Resolvable two ways, neither
   blocking: (a) once `TANGO_API_KEY` is available, capture a small number of real deliveries
   (`diag-tango-webhook-contract` / a real registered endpoint, per F10) and confirm timestamps
   vary as expected; (b) ask MakeGov directly whether `checked_at`/`timestamp` uniquely identifies
   a delivery attempt.
2. **Could MakeGov sign a delivery id, or include one in the body?** If a future SDK version or a
   direct conversation with MakeGov produced either a documented `delivery_id` body field or a
   signed delivery-id header, that would be a strictly better, purpose-built identity, and would
   automatically take precedence under the fixed `readEnvelope`'s existing body-key-first
   precedence (or would need one more line added if it arrived as a *signed* header — signature
   coverage would need re-verification per §2 if MakeGov ever changes what the HMAC covers). Not
   required for this fix to be correct today.
3. **No live capture exists yet (F10, unchanged by this fix).** The receiver has never been
   registered with the provider and no real payload has ever reached this code. This plan's new
   tests in §6.3 are built from the vendor SDK's *documented* samples, which is strong offline
   evidence (this is precisely the standard the prior review applied) but is not the same as a
   live-verified assertion. Recommend running `diag-tango-webhook-contract` and capturing one real
   delivery the first time a `TANGO_API_KEY` and a registered endpoint are available, independent
   of this fix.

---

## 9. Rollout / verification checklist

For whoever implements §5–§6:

1. Apply changes in the order given in §5.5.
2. `tsc` (or the project's typecheck script) over `apps/api` should surface every call site that
   still needs updating — treat any remaining `TangoWebhookRejection`/`missing_delivery_id` or
   `readEnvelope(..., undefined, ...)` compile error as a checklist item, not a surprise.
3. Run the same test subset the prior review used, so the result is directly comparable:
   ```
   ./node_modules/.bin/jest --testTimeout=60000 \
     --testPathPattern "(tango-webhook|diag-tango-webhook-contract|configure-api-http-app)"
   ```
   Expect all pre-existing tests plus the new ones in §6.3 to pass; expect zero tests referencing
   `missing_delivery_id`.
4. Confirm no schema drift was introduced: `prisma migrate diff` (or equivalent) against the
   current migration history should show no pending changes, since §4 concluded none are needed.
5. Downstream-consumer sanity check (already performed once during this planning pass, but worth
   re-confirming after the code change): `git grep -n "\.deliveryId\b"` under
   `apps/api/scripts/process-tango-events.ts`,
   `apps/api/src/funding-opportunities/tango-event-processor.service.ts`, and
   `apps/api/scripts/reconcile-tango-webhook-alerts.ts`. As of this plan, every downstream use of
   `deliveryId` is either an opaque log interpolation or an opaque pass-through into
   `TangoEventOutbox.deliveryId` (itself documented as "no relation, deliberately") — nothing
   parses it as a UUID or matches it against a provider-specific format, so a 64-character hex
   value flowing through is safe. Re-check this grep after the change in case new consumers were
   added in the meantime.
6. This receiver is still deployed dark (`TANGO_WEBHOOK_SIGNING_SECRET` unset per F10) — this fix
   does not change that, and does not need a live secret or a registered endpoint to be verified,
   only the test subset above.
