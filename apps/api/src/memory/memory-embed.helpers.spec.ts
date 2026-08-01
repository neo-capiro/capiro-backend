import { embeddableText } from './memory-ingest.service.js';
import type { MemoryItem } from './memory.types.js';

function item(partial: Partial<MemoryItem>): MemoryItem {
  return {
    id: '',
    tenantId: 't',
    clientId: null,
    ownerUserId: null,
    type: 'client-hub',
    visibility: 'tenant',
    entityId: null,
    slug: 's',
    title: 'Untitled',
    aliases: [],
    tags: [],
    source: 'ingest',
    sourceRef: null,
    provenance: 'ingest@1',
    sections: [],
    createdAt: '',
    updatedAt: '',
    schemaVersion: 1,
    ...partial,
  } as MemoryItem;
}

describe('embeddableText (memory embedding input)', () => {
  it('includes title and human-authored section bodies', () => {
    const text = embeddableText(
      item({
        title: 'Acme Corp',
        sections: [
          { key: 'soul', heading: 'Soul', owner: 'human', body: 'Cares about shipyard funding.' },
          {
            key: 'overview',
            heading: 'Overview',
            owner: 'engine',
            body: 'Auto-generated boilerplate.',
          },
        ],
      }),
    );
    expect(text).toContain('Acme Corp');
    expect(text).toContain('shipyard funding');
  });

  it('excludes engine-owned sections (boilerplate would dilute relevance)', () => {
    const text = embeddableText(
      item({
        title: 'X',
        sections: [
          {
            key: 'overview',
            heading: 'Overview',
            owner: 'engine',
            body: 'ENGINE_BOILERPLATE_TOKEN',
          },
        ],
      }),
    );
    expect(text).not.toContain('ENGINE_BOILERPLATE_TOKEN');
  });

  it('returns just the normalized title when there are no human sections', () => {
    const text = embeddableText(item({ title: 'Solo Title', sections: [] }));
    expect(text).toContain('Solo Title');
  });
});
