import {
  selectedRecordBriefs,
  renderReportWithBriefs,
  developmentKey,
  type IncludedRecordBrief,
} from './record-report-composition.js';
import type { ReportDocument } from './report-domain.js';
describe('explicit daily record brief composition', () => {
  const selected = {
    eventId: 'event',
    briefId: 'exact-brief',
    contentHash: 'a'.repeat(64),
    sourceHash: 'b'.repeat(64),
    version: 2,
    approvedAt: '2026-09-13T12:00:00Z',
  };
  it('rejects implicit latest, missing hashes and duplicated selections', () => {
    expect(selectedRecordBriefs(undefined)).toEqual([]);
    expect(() => selectedRecordBriefs([{ eventId: 'event', briefId: 'latest' }])).toThrow();
    expect(() => selectedRecordBriefs([selected, selected])).toThrow('DUPLICATE');
    expect(selectedRecordBriefs([selected])).toEqual([selected]);
  });
  it('renders a development once while preserving the saved report, analysis and correction', () => {
    const event = {
      sourceIdentity: 'a1',
      revisionHash: 'h1',
      date: '2026-09-12',
      text: 'Repeated legislative development',
      kind: 'action',
      url: null,
    };
    const doc = {
      name: 'Daily',
      cutoff: '2026-09-13',
      audience: 'external',
      generatedAt: '2026-09-13',
      definitionVersion: 1,
      issues: [],
      complete: true,
      currentFieldsNotice: 'Source facts',
      datePolicy: 'Dates retained',
      settings: { actions: 'all', links: 'public' },
      rows: [
        {
          id: 'fl-2026-sb474',
          number: 'SB 474',
          title: 'Synthetic bill',
          folderName: 'Client folder',
          actions: [event],
          amendments: [],
          committees: [],
          relations: [],
        },
      ],
      updates: {
        windowStart: '2026-09-12',
        windowEnd: '2026-09-13',
        records: [{ ...event, billId: 'fl-2026-sb474', number: 'SB 474' }],
      },
    } as unknown as ReportDocument;
    const frozen = JSON.stringify(doc),
      included: IncludedRecordBrief = {
        ...selected,
        title: 'Client brief',
        kind: 'record_correction',
        markdown:
          'Repeated legislative development\nCapiro analysis: Client impact remains uncertain.\nLater change, not a repair of what was true earlier.',
        developmentKeys: [developmentKey('fl-2026-sb474', 'a1', 'h1')],
      };
    const rendered = renderReportWithBriefs(doc, [included]);
    expect(rendered.text.match(/Repeated legislative development/g)).toHaveLength(1);
    expect(rendered.text).toContain('REVIEWED CORRECTION');
    expect(rendered.text).toContain('Client impact remains uncertain');
    expect(JSON.stringify(doc)).toBe(frozen);
    expect(
      renderReportWithBriefs(doc, [
        { ...included, developmentKeys: [developmentKey('fl-2026-hb474', 'a1', 'h1')] },
      ]).text.match(/Repeated legislative development/g),
    ).toHaveLength(3);
  });
});
