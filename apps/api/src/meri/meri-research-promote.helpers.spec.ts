import { detectDeliverableReportRequest } from './meri-research-promote.helpers.js';

describe('detectDeliverableReportRequest', () => {
  describe('triggers (build a deliverable report/brief)', () => {
    it('fires on the real Immobileyes incident prompt', () => {
      const prompt =
        'use everything in this chat thread as background, then find any and all ' +
        'Program Elements, etc. that this company with its capabilities could leverage. ' +
        'please create a full detailed report and brief';
      const d = detectDeliverableReportRequest(prompt);
      expect(d).not.toBeNull();
      expect(d?.topic).toContain('Program Elements');
    });

    it('fires on an explicit comprehensive report ask', () => {
      expect(
        detectDeliverableReportRequest(
          'build me a comprehensive report on the counter-UAS program elements for this client',
        ),
      ).not.toBeNull();
    });

    it('fires on a multi-entity survey framed as a brief', () => {
      expect(
        detectDeliverableReportRequest(
          'create a brief covering all the relevant appropriations bills and every acquisition office',
        ),
      ).not.toBeNull();
    });

    it('fires on "generate a detailed dossier"', () => {
      expect(
        detectDeliverableReportRequest(
          'generate a detailed dossier on this defense contractor and its federal footprint',
        ),
      ).not.toBeNull();
    });

    it('fires on "put together a thorough white paper"', () => {
      expect(
        detectDeliverableReportRequest(
          'put together a thorough white paper on the directed-energy funding landscape',
        ),
      ).not.toBeNull();
    });
  });

  describe('does NOT trigger (stays in chat)', () => {
    it('ignores a plain question', () => {
      expect(
        detectDeliverableReportRequest('what program elements might fit this client?'),
      ).toBeNull();
    });

    it('ignores a single-fact lookup', () => {
      expect(
        detectDeliverableReportRequest(
          'who is the ranking member of the strategic forces subcommittee',
        ),
      ).toBeNull();
    });

    it('ignores very short messages even with keywords', () => {
      expect(detectDeliverableReportRequest('write a report')).toBeNull();
    });

    it('ignores an edit/revision of an existing report', () => {
      expect(
        detectDeliverableReportRequest(
          'edit the report above to be shorter and tighten the summary',
        ),
      ).toBeNull();
    });

    it('ignores rewriting the draft', () => {
      expect(
        detectDeliverableReportRequest(
          'rewrite this draft so it is more comprehensive and detailed',
        ),
      ).toBeNull();
    });

    it('ignores single-file doc-gen with no report noun (create_word path)', () => {
      expect(
        detectDeliverableReportRequest('make me a word doc of the full client contact list please'),
      ).toBeNull();
    });

    it('ignores an outreach email draft', () => {
      expect(
        detectDeliverableReportRequest(
          'draft a detailed email to Senator Moreno introducing the client',
        ),
      ).toBeNull();
    });

    it('ignores a report ask with no scope/multi-entity signal', () => {
      expect(
        detectDeliverableReportRequest('can you create a brief on the OH-14 representative for me'),
      ).toBeNull();
    });

    it('ignores a bill summary request', () => {
      expect(
        detectDeliverableReportRequest(
          'summarize what this bill does and who introduced it in plain terms',
        ),
      ).toBeNull();
    });

    it('ignores empty / whitespace', () => {
      expect(detectDeliverableReportRequest('')).toBeNull();
      expect(detectDeliverableReportRequest('   ')).toBeNull();
    });
  });

  it('caps the topic at 4000 chars', () => {
    const long =
      'build a comprehensive report on ' + 'x'.repeat(5000) + ' across all program elements';
    const d = detectDeliverableReportRequest(long);
    expect(d).not.toBeNull();
    expect((d as { topic: string }).topic.length).toBeLessThanOrEqual(4000);
  });
});
