import { parseLegiwatchReview, receiveLegiwatchReview } from './legiwatch-review.contract.js';
const tenant = '10000000-0000-4000-8000-000000000001',
  actor = 'user_fixture';
const folder = {
  id: 'folder',
  tenantId: tenant,
  clientId: null,
  name: 'Folder 界',
  code: null,
  archived: false,
  ownerClerkId: actor,
  otherUserAccess: 'read',
  defaultSession: '119',
  jurisdiction: 'US',
  version: 0,
  canEdit: true,
  canManage: true,
  count: 0,
};
describe('LegiWatch owner review projection', () => {
  it('preserves General folders and actionable owner fields without tenant columns', () => {
    const p: any = receiveLegiwatchReview(
      { view: 'folders', clientId: null },
      { folders: [folder], scope: { clientId: null }, effects: [] },
      tenant,
      actor,
    );
    expect(p.data.folders[0]).toEqual(
      Object.fromEntries(Object.entries(folder).filter(([k]) => k !== 'tenantId')),
    );
    expect(p.coverage.ownerRowLimit).toBeNull();
    expect(p.effects).toEqual([]);
  });
  it('preserves rule configuration/readiness and declares the existing filtered 201-row owner limit', () => {
    const row = {
      id: 'rule',
      tenant_id: tenant,
      owner_clerk_id: actor,
      name: 'Rule',
      version: 3,
      state: 'paused',
      config: {
        folderIds: ['folder'],
        scope: { jurisdiction: 'US', sessionKey: '119', fields: ['title'] },
        cadence: 'realtime',
      },
      activation: null,
      issues: ['RULE_PAUSED'],
      compiled: [],
    };
    const p: any = receiveLegiwatchReview(
      { view: 'rules', clientId: null, folderId: 'folder' },
      [row],
      tenant,
      actor,
    );
    expect(p.data.rows[0].config).toEqual(row.config);
    expect(p.coverage.ownerRowLimit).toBe(201);
    expect(p.coverage.sourceUniverseComplete).toBe(false);
  });
  it('retains workflow state/steps and excludes lease ownership', () => {
    const row = {
      id: 'action',
      tenant_id: tenant,
      owner_clerk_id: actor,
      workflow_id: null,
      template: 'added_bill_review',
      input_hash: 'hash',
      input: { folderIds: ['folder'], sessionKey: '119' },
      state: 'partial',
      reason: 'RETRY_REQUIRED',
      steps: { draftId: 'draft' },
      lease_token: 'private-lease',
    };
    const p: any = receiveLegiwatchReview(
      { view: 'workflows', clientId: null, folderId: 'folder' },
      [row],
      tenant,
      actor,
    );
    expect(p.data.rows[0].steps).toEqual(row.steps);
    expect(p.data.rows[0]).not.toHaveProperty('lease_token');
    expect(p.coverage.ownerRowLimit).toBe(100);
  });
  it('does not equate foreign or malformed folders with empty data', () => {
    expect(() =>
      receiveLegiwatchReview(
        { view: 'folders', clientId: null },
        {
          folders: [{ ...folder, tenantId: '20000000-0000-4000-8000-000000000001' }],
          scope: { clientId: null },
          effects: [],
        },
        tenant,
        actor,
      ),
    ).toThrow();
  });
  it('keeps folder/rule reads closed and requires exact suggestion session', () => {
    expect(() =>
      parseLegiwatchReview({ view: 'suggestions', clientId: null, folderId: 'folder' }),
    ).toThrow();
    expect(() =>
      parseLegiwatchReview({
        view: 'rules',
        clientId: null,
        folderId: 'folder',
        cursor: 'ignored',
      }),
    ).toThrow();
    expect(() =>
      parseLegiwatchReview({ view: 'folders', clientId: null, action: 'activate' }),
    ).toThrow();
  });
});
