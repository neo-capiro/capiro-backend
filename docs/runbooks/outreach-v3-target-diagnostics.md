# Outreach V3 Target Intelligence Diagnostics

## Dark flags

Target APIs require both:

```text
OUTREACH_V3_STATE_ENABLED=true
OUTREACH_V3_TARGETS_ENABLED=true
```

Malformed target-flag values fail configuration at guard construction. Disabled behavior is 404.

## Verification

```bash
pnpm verify:outreach-v3-phase-4
pnpm verify:outreach-v3-phase-4:local -- --sha "$(git rev-parse HEAD)"
```

## Safe troubleshooting order

1. Verify exact release SHA and `engagement-api` service identity.
2. Verify both dark flags.
3. Verify authenticated user/tenant and session ownership.
4. Verify Campaign Spec targeting criteria.
5. Verify target source is enabled for the request.
6. Verify client access when a client source is requested.
7. Open profile and inspect role/email/profile warnings.
8. Inspect coverage and snapshot-revalidation status.
9. Inspect structured logs by operation/session ID; do not add target content to logs.

## Common outcomes

### No recommendations

- selected target keys are automatically excluded;
- exact rejected recommendation references are excluded;
- filters may have no supported current source;
- agency/local target sources are not implemented in Phase 4;
- outgoing/inactive records are not recommended.

### Target not found

Missing, unauthorized and ethical-wall targets deliberately share the same response.

Do not weaken this behavior for debugging.

### Snapshot changed

The profile/coverage response lists safe changed-field names. Reading does not refresh Campaign Spec.

A user may remove/re-add the target to accept the current source snapshot. A dedicated refresh command may be added only under an explicit later contract.

### Duplicate email

Email is not canonical identity. Coverage treats a shared email as a collision that prevents send readiness. Do not silently merge target identities.

### Existing relationship not proven

Run the client-scoped relationship capability. Its result uses meeting, email-envelope and task metadata only. Private bodies remain excluded.

## Never log

- target email or phone
- target name
- private notes
- meeting-note bodies
- email bodies
- client-sensitive context
- model prompts or tool-result bodies

Use target keys, snapshot hashes, result counts, operation codes and duration.
