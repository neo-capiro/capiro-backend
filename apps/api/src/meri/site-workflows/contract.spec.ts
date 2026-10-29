import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { parseSaveSiteWorkflow, parseSiteWorkflowManifest, parseSiteWorkflowSelection } from '@capiro/shared/site-workflows';
import { ROLES_KEY } from '../../auth/roles.decorator.js';
import { SiteWorkflowAdminController, SiteWorkflowRuntimeController } from './controller.js';
import { workflowFixture } from './fixture.js';
import { workflowDigest } from './store.js';
describe('site workflow administration contract', () => {
  it('preserves exact manifest and returns an independent snapshot', () => {
    const original = workflowFixture(), parsed = parseSiteWorkflowManifest(original);
    expect(parsed).toEqual(original); parsed.tools.pop(); expect(original.tools).toHaveLength(3);
    const reversed = Object.fromEntries(Object.entries(original).reverse());
    expect(workflowDigest(reversed)).toBe(workflowDigest(original));
  });
  it.each([
    { token: 'credential' }, { sessionTtlMs: 28800001 }, { approvalRequired: [] }, { version: 0 },
    { origins: ['http://records.example.com'] }, { origins: ['https://127.0.0.1'] },
    { signInUrl: 'https://actor:credential@login.example.com' }, { signInUrl: 'https://unlisted.example.com' },
    { origins: ['https://metadata.google.internal'] }, { origins: ['https://records.example.com/path'] },
    { downloads: { formats: ['exe'], maxBytes: 10, maxFiles: 1 } }, { signedInProbe: { kind: 'script', value: 'alert(1)' } },
    { signedInProbe: { kind: 'selector', value: 'form', cookies: [] } }, { sensitiveSelectors: [{ password: 'hidden' }] },
  ])('refuses malformed, secret-bearing or widened manifest %#', change => {
    expect(() => parseSiteWorkflowManifest({ ...workflowFixture(), ...change })).toThrow();
  });
  it('requires exact next version and enabling evidence, but allows disabled preparation', () => {
    const manifest = workflowFixture(), request = { requestId: randomUUID(), expectedVersion: 0, manifest, enabled: true };
    expect(parseSaveSiteWorkflow(request)).toEqual(request);
    expect(() => parseSaveSiteWorkflow({ ...request, expectedVersion: 1 })).toThrow();
    manifest.tosReviewRef = null;
    expect(() => parseSaveSiteWorkflow(request)).toThrow('EVIDENCE_REQUIRED');
    expect(parseSaveSiteWorkflow({ ...request, enabled: false }).enabled).toBe(false);
    expect(() => parseSaveSiteWorkflow({ ...request, actorId: randomUUID() })).toThrow();
  });
  it('binds selection to exact version/hash and has separate admin/service boundaries', () => {
    const manifest = workflowFixture(), selection = { siteId: manifest.siteId, workflowId: manifest.workflowId,
      version: 1, manifestSha256: workflowDigest(manifest) };
    expect(parseSiteWorkflowSelection(selection)).toEqual(selection);
    expect(() => parseSiteWorkflowSelection({ ...selection, enabled: true })).toThrow();
    expect(Reflect.getMetadata(ROLES_KEY, SiteWorkflowAdminController)).toEqual(['capiro_admin']);
    const controller = new SiteWorkflowRuntimeController({} as never);
    expect(() => controller.read({} as never, {}, {} as never)).toThrow('Verified service identity required');
  });
});

