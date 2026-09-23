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

## Rollback

- Close the affected capability, tenant flag, allowlist entry, or fleet switch to refuse new work.
- Run reads, event replay, and Stop remain owner-authorized after admission so gate rollback drains rather than strands work.
- Do not drop the additive table during application rollback. Newer token rows safely coexist and remain revoked/unused while the capability is off.
- Keep event rows and canonical meeting/file records. Never roll back by deleting accepted runs or user data.
- If access leakage is suspected, close `MERI_MOBILE_ENABLED`, revoke sessions/device tokens, preserve audit evidence, and investigate before re-enabling.

Hermes event retention remains the existing bounded repository policy: sequence 1 plus the newest configured event window are retained, while `outputSnapshot` through `outputSeq` is authoritative. Recovery renders the snapshot then requests `events?after=outputSeq`; clients must not assume `after=0` retains every old delta.

## Environment-dependent gates not claimed here

- No development/staging deployment was performed by this change.
- No queued or active staging disconnect proof has been run against an enabled dedicated pilot tenant.
- No APNs key, Apple team, bundle identifier, physical-device send, signing, TestFlight, or App Store proof is claimed.
- No production deployment is authorized by this plan.
