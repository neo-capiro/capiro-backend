import { createHash } from 'node:crypto';
import { editorialWorkspace, formatLegacyEditorialCoverage } from './editorial-content.js';
import { renderEditorialOutput } from './editorial-output.js';
import { EditorialDraftSourceController } from './editorial-source.controller.js';
import { NotFoundException } from '@nestjs/common';

describe('editorial report output', () => {
  it('legacy repair changes only the exact generated gap suffix and is idempotent', () => {
    const context = { snapshotId: 'selection', gaps: [{ id: 'id', reason: 'Partial fields' }] };
    const config = {
      legiwatch: { mode: 'editorial', snapshotId: 'selection' },
      sections: ['Cutoff and coverage'],
      sectionContent: {
        'Cutoff and coverage':
          '<p>Human edited introduction.</p><p>[{&quot;id&quot;:&quot;id&quot;,&quot;reason&quot;:&quot;Partial fields&quot;}]</p>',
      },
      humanSetting: true,
    };
    const repaired = formatLegacyEditorialCoverage(config, context, [
      { id: 'id', title: 'Published article' },
    ])!;
    expect(repaired).toMatchObject({
      humanSetting: true,
      sectionContent: {
        'Cutoff and coverage':
          '<p>Human edited introduction.</p><ul><li><strong>Published article:</strong> Partial fields</li></ul>',
      },
    });
    expect(formatLegacyEditorialCoverage(repaired, context, [])).toBeNull();
    expect(
      formatLegacyEditorialCoverage(config, { ...context, snapshotId: 'other' }, []),
    ).toBeNull();
    expect(
      formatLegacyEditorialCoverage(
        {
          ...config,
          sectionContent: { 'Cutoff and coverage': '<p>Manually written coverage notice.</p>' },
        },
        context,
        [],
      ),
    ).toBeNull();
  });
  it('renders ordered edited sections, rich tables and citations, not the obsolete primary body', () => {
    const snapshot = {
      title: 'Client edition',
      config: {
        sections: ['Human summary'],
        sectionContent: {
          'Human summary':
            '<p>Edited <strong>analysis</strong> <a href="https://www.flsenate.gov/">[1]</a></p><table><tr><th>Item</th><th>Amount</th></tr><tr><td>Operating</td><td>$20,500</td></tr></table>',
        },
        mainBlocks: [{ type: 'table', cells: [['Capital', '$29,500']] }],
      },
      documents: [
        { name: 'Primary', body: { blocks: [{ type: 'section', content: 'STALE PRIMARY' }] } },
        {
          name: 'Appendix',
          body: { blocks: [{ type: 'section', content: '<p>Authored appendix.</p>' }] },
        },
      ],
    };
    const output = renderEditorialOutput(snapshot);
    expect(output.html).toContain('<h2>Human summary</h2><p>Edited <strong>analysis</strong>');
    expect(output.html).toContain('<a href="https://www.flsenate.gov/">[1]</a>');
    expect(output.html).toContain('<td>$20,500</td>');
    expect(output.html).toContain('<th>$29,500</th>');
    expect(output.html.indexOf('Authored appendix.')).toBeLessThan(
      output.html.indexOf('Client edition'),
    );
    expect(output.html).not.toContain('STALE PRIMARY');
    expect(output.html).not.toContain('<pre');
    expect(output.text).toContain('Edited analysis [1]');
  });
  it('shows gap reasons and source titles while retaining original identifiers only in audit context', () => {
    const result = editorialWorkspace({
      context: {
        template: 'research_update',
        gaps: [{ id: 'private-internal-id', reason: 'Available article fields only' }],
      },
      sources: [{ id: 'private-internal-id', title: 'Published coverage' }],
    });
    const html = result.config.sectionContent['Cutoff and coverage'];
    expect(html).toContain('<strong>Published coverage:</strong> Available article fields only');
    expect(html).not.toContain('private-internal-id');
    expect(html).not.toContain('&quot;reason&quot;');
    expect(result.contextItem.payload.text).toContain('private-internal-id');
  });
  it('sanitizes user edits including encoded dangerous links and applies current export redactions', () => {
    const output = renderEditorialOutput({
      title: 'Private client',
      documents: [],
      config: {
        anonymize: true,
        anonymizeMap: { redactions: [{ from: 'Private client', to: '[Client]' }] },
        sections: ['Summary'],
        sectionContent: {
          Summary:
            '<p onclick="steal()">Private client</p><script>steal()</script><a href="&#106;avascript:alert(1)" onclick="steal()">bad</a><a href="https://example.org/" data-href="javascript:steal()">source</a>',
        },
      },
    });
    expect(output.html).not.toContain('Private client');
    expect(output.html).not.toMatch(/steal\(|javascript:|onclick/);
    expect(output.html).toContain('<a href="#">bad</a>');
    expect(output.html).toContain('<a href="https://example.org/">source</a>');
    expect(output.html).toContain('[Client]');
  });
  it('does not silently approve a report that omits inserted media', () => {
    expect(() =>
      renderEditorialOutput({
        title: 'Edition',
        documents: [],
        config: { mainBlocks: [{ type: 'photo', src: 'data:image/png;base64,...' }] },
      }),
    ).toThrow('EDITORIAL_MEDIA_REQUIRES_DOCUMENT_EXPORT');
  });
  it('keeps snapshot hashes exact and changes output after a human edit', async () => {
    const draft = {
      id: 'draft',
      docTitle: 'Edition',
      config: { sections: ['Summary'], sectionContent: { Summary: '<p>Initial</p>' } },
      documents: [],
    };
    const drafts = { byId: jest.fn(async () => draft) };
    const controller = new EditorialDraftSourceController(
      drafts as never,
      { $queryRaw: jest.fn(async () => [{ draft_id: 'draft' }]) } as never,
    );
    const first = await controller.output('selection', 'tenant', 'actor');
    expect(first.outputHash).toBe(
      createHash('sha256').update(JSON.stringify(first.snapshot)).digest('hex'),
    );
    draft.config.sectionContent.Summary = '<p>Edited</p>';
    const second = await controller.output('selection', 'tenant', 'actor');
    expect(second.outputHash).not.toBe(first.outputHash);
    expect(second.html).toContain('<p>Edited</p>');
    expect(drafts.byId).toHaveBeenCalledWith('tenant', 'draft', 'actor');
  });
  it('draft lookup hides revoked private metadata and keeps the ordinary read guard', async () => {
    const drafts = {
      byId: jest.fn(async (_tenant: string, id: string) => {
        if (id === 'revoked') throw new NotFoundException();
        return { id, docTitle: 'Accessible edition', updatedAt: new Date('2026-09-14') };
      }),
    };
    const prisma = {
      $queryRaw: jest.fn(async () => [
        { source_key: 'one', draft_id: 'revoked' },
        { source_key: 'two', draft_id: 'visible' },
      ]),
    };
    const controller = new EditorialDraftSourceController(drafts as never, prisma as never);
    const result = await controller.lookup({
      tenantId: '11111111-1111-1111-1111-111111111111',
      ownerId: 'actor',
      selectionIds: ['one', 'two'],
    });
    expect(result.drafts.map((d) => d.draftId)).toEqual(['visible']);
    expect(drafts.byId).toHaveBeenCalledWith(
      '11111111-1111-1111-1111-111111111111',
      'revoked',
      'actor',
      expect.any(AbortSignal),
    );
    expect(prisma.$queryRaw.mock.calls[0]?.slice(1)).toEqual([
      '11111111-1111-1111-1111-111111111111',
      'actor',
      ['one', 'two'],
    ]);
  });
});
