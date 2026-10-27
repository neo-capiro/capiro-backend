import {
  WorkspaceShareLifecycle,
  ShareOperationConflict,
  type WorkspaceShareRecord,
  type WorkspaceSharePersistence,
} from '@capiro/shared/workspace-share-lifecycle';
import { projectSharedWorkspaceDocument } from './share-document-projection.js';

function fixture() {
  const rows: Array<WorkspaceShareRecord & Record<string, unknown>> = [];
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => row[key] === value);
  const store = {
    findFirst: jest.fn(async ({ where }) => rows.find((row) => matches(row, where)) ?? null),
    findMany: jest.fn(async ({ where }) => rows.filter((row) => matches(row, where))),
    create: jest.fn(async ({ data }) => {
      const row = { id: `link-${rows.length}`, revokedAt: null, ...data } as WorkspaceShareRecord &
        Record<string, unknown>;
      rows.push(row);
      return row;
    }),
    update: jest.fn(async ({ where, data }) => {
      const row = rows.find((row) => matches(row, where));
      if (!row) throw new Error('missing');
      Object.assign(row, data);
      return row;
    }),
    updateMany: jest.fn(async ({ where, data }) => {
      const selected = rows.filter((row) => matches(row, where));
      selected.forEach((row) => Object.assign(row, data));
      return { count: selected.length };
    }),
    count: jest.fn(async ({ where }) => rows.filter((row) => matches(row, where)).length),
  } as WorkspaceSharePersistence<WorkspaceShareRecord>;
  return {
    rows,
    store,
    document: new WorkspaceShareLifecycle(store, 'workspace_document'),
    research: new WorkspaceShareLifecycle(store, 'research_portfolio'),
  };
}

describe('canonical Workspace share lifecycle', () => {
  const input = {
    tenantId: 'tenant',
    resourceId: 'resource',
    createdById: 'actor',
    operationKey: 'operation',
    request: { label: 'Client copy', versionId: 'v1' },
    payload: { text: 'all content' },
  };

  it('uses one store, emits one capability and binds replay to the whole request', async () => {
    const f = fixture();
    const first = await f.document.publish(input);
    expect(first.token).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(f.rows)).not.toContain(first.token);
    expect(await f.document.publish(input)).toMatchObject({
      token: null,
      replayed: true,
      row: { id: first.row.id },
    });
    await expect(
      f.document.publish({ ...input, request: { ...input.request, label: 'Changed label' } }),
    ).rejects.toBeInstanceOf(ShareOperationConflict);
    await expect(
      f.document.publish({ ...input, request: { ...input.request, versionId: 'v2' } }),
    ).rejects.toBeInstanceOf(ShareOperationConflict);
    expect(f.rows).toHaveLength(1);
  });

  it('scopes operations and token lookups by kind, resource and tenant', async () => {
    const f = fixture();
    const doc = await f.document.publish(input);
    const research = await f.research.publish(input);
    expect(await f.research.byToken(doc.token!)).toBeNull();
    expect(await f.document.byToken(research.token!)).toBeNull();
    expect(await f.document.operation('other', input.resourceId, input.operationKey)).toBeNull();
    expect(await f.document.operation(input.tenantId, 'other', input.operationKey)).toBeNull();
    expect(f.rows).toHaveLength(2);
  });

  it('fixes portfolio lifetime at exactly168hours and denies its exact boundary', async () => {
    const f = fixture();
    const now = new Date('2026-10-27T00:00:00Z');
    const result = await f.research.publish({ ...input, now, expiresInDays: 20 });
    expect(result.row.expiresAt!.getTime() - now.getTime()).toBe(168 * 3600000);
    expect(f.research.isLive(result.row, result.row.expiresAt!.getTime() - 1)).toBe(true);
    expect(f.research.isLive(result.row, result.row.expiresAt!.getTime())).toBe(false);
    await f.research.revoke(result.row);
    expect(f.research.isLive(result.row, now.getTime())).toBe(false);
  });

  it('allows a full frozen logo envelope and refuses oversized content before insertion', async () => {
    const f = fixture();
    await f.research.publish({
      ...input,
      payload: { logoBinding: { dataUrl: 'x'.repeat(3 * 1024 * 1024) } },
    });
    await expect(
      f.document.publish({ ...input, payload: { text: 'x'.repeat(9 * 1024 * 1024) } }),
    ).rejects.toThrow('8 MiB');
    expect(f.rows).toHaveLength(1);
  });
});

describe('full Workspace publication projection', () => {
  it('uses the canonical Workspace entity and inline text conversion', () => {
    const result = projectSharedWorkspaceDocument({
      docTitle: 'A &amp; B',
      config: {
        mainBlocks: [
          { type: 'section', content: '<p>A &amp; B</p><p>First<b>second</b>&nbsp;third</p>' },
        ],
      },
    });
    expect(result.docTitle).toBe('A & B');
    expect(result.sections[0]?.content).toBe('A & B\nFirst second third');
  });

  it.each([
    { config: { product: 'Newsletter' }, documents: [{ body: {} }] },
    { config: {}, documents: [{ body: { newsletter: { subject: 'Authored content' } } }] },
  ])('refuses authored Newsletter content before falling back to generic blocks', (saved) => {
    expect(() =>
      projectSharedWorkspaceDocument({
        ...saved,
        config: {
          ...saved.config,
          sections: ['Summary'],
          sectionContent: { Summary: 'Derived fallback' },
          mainBlocks: [{ type: 'section', content: 'More fallback' }],
        },
      }),
    ).toThrow('newsletter');
  });

  it('refuses an unsupported authored primary body instead of silently omitting it', () => {
    expect(() =>
      projectSharedWorkspaceDocument({
        config: { mainBlocks: [{ type: 'section', content: 'Generic fallback' }] },
        documents: [{ body: { unsupportedAuthoredContent: 'Must not disappear' } }],
      }),
    ).toThrow('unsupported primary body');
  });

  it('keeps content beyond2000 characters and includes text/table blocks and packet documents', () => {
    const full = 'a'.repeat(4500);
    const result = projectSharedWorkspaceDocument({
      docTitle: 'Document',
      config: {
        sections: ['Summary'],
        sectionContent: { Summary: full },
        mainBlocks: [
          {
            type: 'table',
            cells: [
              ['Header', 'Value'],
              ['Count', 42],
            ],
          },
        ],
      },
      documents: [
        { id: 'primary', body: {} },
        {
          name: 'Appendix',
          body: { blocks: [{ type: 'section', content: '<p>Complete appendix</p>' }] },
        },
      ],
    });
    expect(result.sections[0]?.content).toBe(full);
    expect(result.sections.some((section) => section.content.includes('Count\t42'))).toBe(true);
    expect(result.sections.some((section) => section.title === 'Appendix')).toBe(true);
    expect(result.sections.some((section) => section.content === 'Complete appendix')).toBe(true);
  });

  it.each(['photo', 'logo', 'unknown'])(
    'refuses unsupported%s content instead of silently omitting it',
    (type) => {
      expect(() =>
        projectSharedWorkspaceDocument({
          docTitle: 'Document',
          config: { mainBlocks: [{ type, src: 'private-image' }] },
        }),
      ).toThrow(`unsupported ${type} block`);
    },
  );
});
