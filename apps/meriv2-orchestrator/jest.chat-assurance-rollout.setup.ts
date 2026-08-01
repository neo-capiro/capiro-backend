/**
 * Phase 17 test-only compatibility boundary for the inherited full-chat suite.
 *
 * The production resolver requires three server-owned controls: global mode,
 * tenant canary, and exact surface. The inherited chat integration spec predates
 * the tenant/surface rollout and intentionally mutates only the global mode in
 * its pre-persistence assertions. Rather than weakening production behavior,
 * provide that one file with a fixed internal tenant and the exact `chat`
 * surface. All explicit rollout specs continue to set and test every control
 * themselves, including missing-control fail-closed behavior.
 */
const testPath = expect.getState().testPath?.replace(/\\/g, '/') ?? '';

if (testPath.endsWith('/src/meri/chat/chat-assistant.service.spec.ts')) {
  process.env.MERI_RELEASE_GATE_TENANTS ??= 't1';
  process.env.MERI_RELEASE_GATE_SURFACES ??= 'chat';
}
