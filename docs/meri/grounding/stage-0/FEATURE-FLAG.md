# Stage 0 evidence-accuracy feature flag

Stage 0 user-visible behavior is controlled by three server environment variables:

- `MERI_EVIDENCE_ACCURACY_MODE`: `off`, `shadow`, or `enforce`; blank and unknown values fail closed to `off`.
- `MERI_EVIDENCE_ACCURACY_TENANTS`: comma/space-separated canonical tenant UUIDs, or the explicit token `all`. Empty enrolls nobody; slugs and malformed IDs are ignored.
- `MERI_EVIDENCE_ACCURACY_SURFACES`: comma/space-separated assurance surfaces: `chat`, `in-editor`, `workspace-gen`, `strategy`, `research`, `outreach`, `memo`, `district-brief`, and `steward`.

The configured mode is effective only when both the authenticated canonical tenant ID and the current surface are enrolled. `off` preserves legacy behavior byte-for-byte. `shadow` preserves legacy output and records what enforcement would change. `enforce` enables the new behavior.

The pilot configuration is:

```text
MERI_EVIDENCE_ACCURACY_MODE=shadow
MERI_EVIDENCE_ACCURACY_TENANTS=17b63099-bc0f-4ac5-b596-496161e9481e
MERI_EVIDENCE_ACCURACY_SURFACES=chat
```

The tenant is `capiro-internal`; only its canonical UUID belongs in configuration. Repository defaults remain off and empty.

## Usage

Server code with a tenant and surface resolves one effective mode:

```ts
const mode = resolveEvidenceAccuracyModeForTenant(tenantContext.tenantId, 'chat');
if (evidenceAccuracyEnforced(mode)) applyAccurateEvidenceBehavior();
```

Shadow paths retain the legacy result and emit a stable structured event:

```ts
if (mode === 'shadow') logger.warn('meri.evidence_accuracy.shadow', wouldChange);
return mode === 'enforce' ? enforcedResult : legacyResult;
```

Web code must not read server environment variables. A later API task must send an explicit payload signal only for `enforce`; legacy payloads render unchanged.

## Release maintenance

Release wiring has a three-lists rule: every variable must be added together to the controlled environment set and both dark-default objects in `prepare-meriv2-ecs-release.mjs`, the matching must-be-off/must-be-empty checks in `execute-meriv2-ecs-release.mjs`, and the literal assertions in `verify-meriv2-release-scripts.mjs`. Run `node scripts/verify-meriv2-release-scripts.mjs` after any change.
