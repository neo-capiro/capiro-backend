import type { Request } from 'express';
import { GENERATION_REQUEST, canonicalGenerationAdmissionSha256 } from './objective-canonical-generation.js';
import { createPrismaCanonicalReaderV2NativeOwner } from './objective-canonical-reader-v2-native-owner.js';
import { nativeReaderV2Fixture, nativeReaderFixtureNow as NOW, nativeReaderFixtureId as id } from './test/objective-canonical-reader-v2-native.fixture.js';

// Actual native-owner + ledger/publication/revision/ACL helper source; only
// native authorization, Prisma rows/transactions and the clock are SYNTHETIC.
function setup() {
  const f = nativeReaderV2Fixture();
  const options = { enabled: true, prisma: f.prisma, authority: f.baseAuthority, retainedAccess: f.retainedAccess, now: f.clock };
  const selector = { generationJobId: f.admission.generationJobId, sourceAdmissionSha256: canonicalGenerationAdmissionSha256(f.admission) };
  const accept = () => createPrismaCanonicalReaderV2NativeOwner(options).readAcceptance({} as Request, f.subject, { signal: new AbortController().signal });
  const retained = () => createPrismaCanonicalReaderV2NativeOwner(options).readRetained(selector, { signal: new AbortController().signal });
  return { ...f, options, selector, accept, retained };
}
describe('actual persisted canonical reader v2 native owner', () => {
  test('reconstructs actual original DTO/admission/publication in one bounded tenant transaction with job-first current checks', async () => {
    const f = setup(), value = await f.accept();
    expect(value.originalDto).toEqual(f.originalDto); expect(value.publication).toEqual(f.publication); expect(value.admission).toEqual(f.admission);
    expect(value.acceptance).toBeNull(); expect(value.checkedAtMs).toBe(NOW); expect(value.expiresAtMs).toBe(NOW + 3000);
    expect(Object.isFrozen(value.originalDto)).toBe(true); expect(f.state.transactions).toBe(1); expect(f.state.generationChecks).toBe(2);
    expect(f.state.events.indexOf('verify-generation')).toBeLessThan(f.state.events.indexOf('tx-open'));
    expect(f.state.events.indexOf('job-lock')).toBeLessThan(f.state.events.indexOf('generation-current'));
    expect(f.state.events.at(-1)).toBe('tx-commit'); expect(f.state.timeoutMs).toEqual([3000]);
  });
  test('receiving before/after calls reauthenticate and reread original custody each time', async () => {
    const f = setup(); await f.accept(); await f.accept(); expect(f.state.verifies).toBe(2); expect(f.state.transactions).toBe(2); expect(f.state.generationChecks).toBe(4);
  });
  test('fresh historical read requires independent native principal access and preserves expired execution custody', async () => {
    const f = setup(); f.state.acceptancePresent = true; f.state.now = NOW + 200000;
    const value = await f.retained(); expect(value.acceptance).toEqual(f.acceptance);
    expect(value.checkedAtMs).toBe(NOW + 200000); expect(value.expiresAtMs).toBe(NOW + 202000);
    expect(f.acceptance.issuance.expiresAtMs).toBe(NOW + 30000); expect(f.state.verifies).toBe(0); expect(f.state.authorizes).toBe(1); expect(f.state.retainedChecks).toBe(2);
  });
  test('default-off and missing server owners never evaluate disabled getters or touch Prisma/authority', async () => {
    const f = setup(); let touched = false;
    const poison = Object.defineProperty({ enabled: false }, 'prisma', { get() { touched = true; throw Error('never'); } });
    for (const options of [{}, poison, { ...f.options, authority: undefined }, { ...f.options, retainedAccess: undefined }, { ...f.options, prisma: undefined }]) {
      await expect(createPrismaCanonicalReaderV2NativeOwner(options).readAcceptance({} as Request, f.subject, { signal: new AbortController().signal })).rejects.toThrow('AUTHORITY_UNAVAILABLE');
    }
    expect(touched).toBe(false); expect(f.state.events).toEqual([]);
  });
  test('server class methods bind their real instance without accepting accessor-based owner discovery', async () => {
    const f = setup();
    class NativeAuthority {
      private readonly base = f.baseAuthority;
      verifyGeneration: typeof f.baseAuthority.verifyGeneration = (...args) => this.base.verifyGeneration(...args);
      async assertGenerationCurrent(...args: Parameters<typeof f.baseAuthority.assertGenerationCurrent>) { return this.base.assertGenerationCurrent(...args); }
    }
    const owner = createPrismaCanonicalReaderV2NativeOwner({ ...f.options, authority: new NativeAuthority() });
    expect((await owner.readAcceptance({} as Request, f.subject, { signal: new AbortController().signal })).admission).toEqual(f.admission);
    let touched = false; const poison = Object.defineProperty({}, 'verifyGeneration', { get() { touched = true; throw Error('never'); } });
    await expect(createPrismaCanonicalReaderV2NativeOwner({ ...f.options, authority: poison as never }).readAcceptance({} as Request, f.subject,
      { signal: new AbortController().signal })).rejects.toThrow(); expect(touched).toBe(false);
  });
  test('malformed native grant/access timestamps cannot become typed source authority', async () => {
    const f = setup(); f.state.grantOverride = value => ({ ...value, checkedAtMs: String(NOW) }); await expect(f.accept()).rejects.toThrow();
    const g = setup(); g.state.accessOverride = value => ({ ...value, checkedAtMs: String(NOW) }); await expect(g.retained()).rejects.toThrow();
    expect(f.state.transactions + g.state.transactions).toBe(0);
  });
  test.each(['dto', 'marker', 'revision', 'publication-hash', 'input-hash', 'original-actor'])('actual stored %s conflict cannot be replaced by matching caller/Meri data', async kind => {
    const f = setup();
    if (kind === 'dto') f.job.input.dto.type = 'regulatory';
    if (kind === 'marker') f.job.input.canonicalGeneration.admissionId = id(99);
    if (kind === 'revision') f.snapshot.outcome = 'Changed revision content';
    if (kind === 'publication-hash') f.published.publicationSha256 = '9'.repeat(64);
    if (kind === 'input-hash') f.published.inputSha256 = '9'.repeat(64);
    if (kind === 'original-actor') f.admission.actorUserId = id(99);
    await expect(f.accept()).rejects.toThrow('AUTHORITY_UNAVAILABLE'); expect(f.state.events).toContain('tx-rollback');
  });
  test.each(['acl', 'objectiveExists', 'revisionExists'] as const)('native %s loss rejects the real source reconstruction', async key => {
    const f = setup(); f.state[key] = false; await expect(f.accept()).rejects.toThrow('AUTHORITY_UNAVAILABLE');
  });
  test('current memory wall remains a real native access fence', async () => {
    const f = setup(); f.state.memoryWall = true; f.state.wallAllowed = false; await expect(f.accept()).rejects.toThrow();
    const g = setup(); g.state.memoryWall = true; expect((await g.accept()).admission).toEqual(g.admission);
  });
  test('a source mutated between native custody reads rejects instead of returning either version', async () => {
    const f = setup(); let revisions = 0;
    f.state.onQuery = sql => { if (/FROM client_objective_revisions/.test(sql) && ++revisions === 2) f.snapshot.minimumWin = 'Changed'; };
    await expect(f.accept()).rejects.toThrow(); expect(f.state.events.at(-1)).toBe('tx-rollback');
  });
  test('the separately captured original DTO must match the input hash reconstructed by the actual publication owner', async () => {
    const f = setup(), replacement = nativeReaderV2Fixture('regulatory'); let swapped = false;
    f.state.onQuery = sql => {
      if (!swapped && /FROM tenants t/.test(sql)) {
        swapped = true;
        // Deliberately violate a real locked row's stability in this synthetic
        // driver, after native capture but before publication reconstruction.
        f.job.input = JSON.parse(JSON.stringify(replacement.job.input));
        f.resourceData.set(GENERATION_REQUEST, replacement.published);
      }
    };
    await expect(f.accept()).rejects.toThrow(); expect(f.state.events.at(-1)).toBe('tx-rollback');
  });
  test('late native authority revocation rolls the source transaction back', async () => {
    const f = setup(); f.state.beforeGenerationCheck = () => { if (f.state.generationChecks === 2) f.state.allowed = false; };
    await expect(f.accept()).rejects.toThrow(); expect(f.state.generationChecks).toBe(2); expect(f.state.events.at(-1)).toBe('tx-rollback');
  });
  test('late independent retained principal revocation rejects despite exact original acceptance', async () => {
    const f = setup(); f.state.acceptancePresent = true;
    f.state.beforeRetainedCheck = () => { if (f.state.retainedChecks === 2) f.state.retainedAllowed = false; };
    await expect(f.retained()).rejects.toThrow(); expect(f.state.events.at(-1)).toBe('tx-rollback');
  });
  test('historical source selector needs actual independent principal authorization, never tenant or caller binding hints', async () => {
    const f = setup(); f.state.acceptancePresent = true; f.state.retainedAllowed = false;
    await expect(f.retained()).rejects.toThrow(); expect(f.state.transactions).toBe(0);
    const g = setup(); g.state.accessOverride = value => ({ ...value, actorUserId: id(99) }); g.state.acceptancePresent = true;
    await expect(g.retained()).rejects.toThrow();
    await expect(createPrismaCanonicalReaderV2NativeOwner(g.options).readRetained({ ...g.selector, tenantId: id(2) } as never,
      { signal: new AbortController().signal })).rejects.toThrow();
  });
  test('retained read cannot proceed without actual persisted acceptance', async () => {
    const f = setup(); await expect(f.retained()).rejects.toThrow();
  });
  test('initial acceptance clips to original effect/issuance expiry and rejects expired execution', async () => {
    const f = setup(); f.state.grantOverride = value => ({ ...value, expiresAtMs: NOW + 20 });
    const value = await f.accept(); expect(value.expiresAtMs).toBe(NOW + 20);
    const g = setup(); g.state.now = NOW + 200000; await expect(g.accept()).rejects.toThrow();
  });
  test('postcommit expiry or abort cannot release a formerly valid native snapshot', async () => {
    const f = setup(); f.state.afterCommit = () => { f.state.now = NOW + 3000; }; await expect(f.accept()).rejects.toThrow();
    const g = setup(), controller = new AbortController(); g.state.afterCommit = () => controller.abort();
    await expect(createPrismaCanonicalReaderV2NativeOwner(g.options).readAcceptance({} as Request, g.subject, { signal: controller.signal })).rejects.toThrow();
    expect(g.state.events).toContain('tx-commit');
  });
  test('transaction budget includes time spent authenticating before Prisma work', async () => {
    const f = setup(); f.state.grantOverride = value => { f.state.now += 1200; return { ...value, checkedAtMs: f.state.now }; };
    await f.accept(); expect(f.state.timeoutMs).toEqual([1800]);
  });
  test('caller abort during native DB checks is denied after rollback without obtaining a source grant', async () => {
    const f = setup(), controller = new AbortController(); f.state.beforeGenerationCheck = () => controller.abort();
    await expect(createPrismaCanonicalReaderV2NativeOwner(f.options).readAcceptance({} as Request, f.subject, { signal: controller.signal })).rejects.toThrow();
    await Promise.resolve(); await Promise.resolve(); expect(f.state.events).not.toContain('tx-commit');
  });
  test('a backward wall clock cannot recover later into a successful read', async () => {
    const f = setup(); f.state.beforeGenerationCheck = () => { f.state.now--; }; await expect(f.accept()).rejects.toThrow();
  });
});
