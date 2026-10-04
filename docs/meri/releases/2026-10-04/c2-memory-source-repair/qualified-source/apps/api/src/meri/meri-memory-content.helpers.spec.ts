import { projectMemoryContent } from './meri-memory-content.helpers.js';
import type { RetrievalRecord } from '../retrieval/retrieval-v2.types.js';

const itemId = '22222222-2222-4222-8222-222222222222';
const ctx = { tenantId: 'tenant-a', userId: 'user-a' };
const body = 'A "quoted" fact with \\ a slash, a newline\n and an emoji 🌿. '.repeat(700);
const record: RetrievalRecord = {
  domain: 'institutional_knowledge',
  recordId: itemId,
  payload: {
    value: body,
    title: 'Approved fact',
    governance: { status: 'active', approvedByUserId: 'reviewer' },
  },
  provenance: { source: 'memory_items', recordId: itemId, sourceVersion: 'version:1' },
};

describe('governed memory content continuation', () => {
  it('carries only canonical row ownership for capture and never fills it from caller scope', () => {
    const canonical = { ...record, provenance: { ...record.provenance, canonicalTenantId: 'row-owner' } };
    expect(projectMemoryContent(ctx, canonical, {}).provenance).not.toHaveProperty('canonicalTenantId');
    expect(projectMemoryContent(ctx, canonical, {captureSourceOwner:true}).provenance?.canonicalTenantId).toBe('row-owner');
    expect(projectMemoryContent({...ctx,tenantId:'another-caller'}, canonical, {captureSourceOwner:true}).provenance?.canonicalTenantId).toBe('row-owner');
    expect(projectMemoryContent(ctx, record, {captureSourceOwner:true}).provenance?.canonicalTenantId).toBeNull();
  });
  it('reads the full long approved body with escaped JSON pages below6k and stable hash/offset references', () => {
    let input: Parameters<typeof projectMemoryContent>[2] = {
      clientId: 'client-a',
      memoryItemId: itemId,
    };
    let complete = '';
    let pages = 0;
    do {
      const page = projectMemoryContent(ctx, record, input);
      expect(JSON.stringify(page, null, 2).length).toBeLessThanOrEqual(6000);
      const content = page.payload.content as {
        hash: string;
        offset: number;
        endOffset: number;
        truncated: boolean;
        nextRead: typeof input | null;
      };
      expect(content.offset).toBe(complete.length);
      expect(content.hash).toHaveLength(64);
      complete += page.payload.value;
      expect(content.endOffset).toBe(complete.length);
      pages += 1;
      if (!content.nextRead) break;
      input = content.nextRead;
      expect(pages).toBeLessThan(50);
    } while (true);
    expect(pages).toBeGreaterThan(2);
    expect(complete).toBe(body);
  });

  it('provides a concise preview with a targeted continuation instead of duplicating section bodies', () => {
    const page = projectMemoryContent(ctx, record, { clientId: 'client-a', maxJsonChars: 2400 });
    expect((page.payload.value as string).length).toBeLessThanOrEqual(500);
    expect(page.payload.content).toMatchObject({
      totalCharacters: body.length,
      truncated: true,
      nextRead: { memoryItemId: itemId, clientId: 'client-a' },
    });
    expect(page.payload).not.toHaveProperty('sections');
  });

  it('rejects a cursor after a canonical correction or actor/client scope change', () => {
    const first = projectMemoryContent(ctx, record, { clientId: 'client-a', memoryItemId: itemId });
    const nextRead = (
      first.payload.content as { nextRead: Parameters<typeof projectMemoryContent>[2] }
    ).nextRead;
    expect(() =>
      projectMemoryContent(
        ctx,
        { ...record, payload: { ...record.payload, value: 'Corrected fact' } },
        nextRead,
      ),
    ).toThrow('Memory content or scope changed');
    expect(() => projectMemoryContent({ ...ctx, userId: 'user-b' }, record, nextRead)).toThrow(
      'Memory content or scope changed',
    );
    expect(() => projectMemoryContent(ctx, record, { ...nextRead, clientId: 'client-b' })).toThrow(
      'Memory content or scope changed',
    );
    expect(() =>
      projectMemoryContent(ctx, record, { ...nextRead, memoryItemId: 'other-item' }),
    ).toThrow('Canonical memory selector');
  });
});
