# Meri iOS Phase 1 rollout and rollback

## Default-closed gates

Every new route requires `MERI_MOBILE_ENABLED=true`, a canonical tenant UUID in `MERI_MOBILE_PILOT_TENANT_IDS`, and tenant setting `meri.mobileApi=true`. Capabilities additionally require both their environment switch and tenant flag:

| Capability | Environment | Tenant setting |
| --- | --- | --- |
| Runs | `MERI_MOBILE_RUNS_ENABLED` | `meri.mobile.runs` |
| Meetings | `MERI_MOBILE_MEETINGS_ENABLED` | `meri.mobile.meetings` |
| Files | `MERI_MOBILE_FILES_ENABLED` | `meri.mobile.files` |
| Device tokens | `MERI_MOBILE_DEVICE_TOKENS_ENABLED` | `meri.mobile.deviceTokens` |

Mobile run admission also requires the existing Hermes fleet, canonical-tenant, and tenant gates. All switches default false or an empty allowlist.

## Expansion

1. Apply the additive device-token migration; leave all flags off. Older API and web code ignore the new table.
2. Deploy API and validate existing web smoke/regression tests.
3. Enable the API and one capability for a dedicated non-customer staging tenant.
4. Run the queued and active disconnect proof from a fresh process. Capture timestamps and opaque run/event IDs only.
5. Enable internal TestFlight users only after the proof passes. Expand one capability and tenant at a time.

The Phase 1 staging proof completed on 2026-09-23 with task definition `capiro-staging-meri-hermes-continuity-proof:4` and exit 0. It used an isolated synthetic tenant that was deleted in cleanup; it did not leave any persistent tenant enabled. See `phase1-verification.md` for the opaque identifiers and assertion matrix.

## Rollback

- Close the affected capability, tenant flag, allowlist entry, or fleet switch to refuse new work.
- Run reads, event replay, and Stop remain owner-authorized after admission so gate rollback drains rather than strands work.
- Do not drop the additive table during application rollback. Newer token rows safely coexist and remain revoked/unused while the capability is off.
- Keep event rows and canonical meeting/file records. Never roll back by deleting accepted runs or user data.
- If access leakage is suspected, close `MERI_MOBILE_ENABLED`, revoke sessions/device tokens, preserve audit evidence, and investigate before re-enabling.

Hermes event retention remains the existing bounded repository policy: sequence 1 plus the newest configured event window are retained, while `outputSnapshot` through `outputSeq` is authoritative. Recovery renders the snapshot then requests `events?after=outputSeq`; clients must not assume `after=0` retains every old delta.

## Verified rollback behavior

- Admission refused the wrong tenant and the pilot tenant while its flag was off.
- Closing the tenant gate while an active run was in flight immediately refused new work but did not strand the admitted run; authorized observation/replay continued until terminal completion.
- Stop remained owner-authorized after gate closure, produced terminal `cancelled`, and no success event followed Stop.
- The staging service configuration contains no Meri mobile/Hermes opt-in environment or secret overrides, so the deployed default state is closed.
- The device-token migration is additive; old web/app health remained green after migration and rollback does not require dropping the table.

## Environment-dependent gates not claimed here

- No APNs key, Apple team, bundle identifier, physical-device send, signing, TestFlight, or App Store proof is claimed.
- ECR critical/high findings must be resolved or accepted through the security release process before any production promotion.
- Product-only/Figma decisions remain deferred as recorded in `phase1-decisions.md`.
- No production deployment is authorized by this plan, and none was performed.
