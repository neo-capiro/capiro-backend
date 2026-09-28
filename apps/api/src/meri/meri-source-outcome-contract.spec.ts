import { classifyApiToolReadOutcome } from '@capiro/shared/meri-read-outcome';

describe('meri-source-outcome-contract', () => {
  const hash = 'a'.repeat(64);

  const owners = [
    ['read_monday_client_boards', 'managed_monday_mcp'],
    ['read_bill_text', 'federal_evidence_current'],
    ['scrape_web_page', 'public_url'],
    ['read_chat_attachments', 'clio_chat_attachment'],
    ['get_research_evidence', 'clio_chat_attachment'],
    ['get_bill_status', 'congress_bill_status'],
  ] as const;

  test.each(owners)(
    '%s honors unavailable owners without requiring a success-shaped coverage envelope',
    (tool, authoritativeOwner) => {
      expect(
        classifyApiToolReadOutcome(tool, { tool, authoritativeOwner, currentStatus: 'unavailable' })
          ?.kind,
      ).toBe('unavailable');
    },
  );

  test.each(owners)(
    '%s rejects missing owner/status and suppresses raw errors',
    (tool, authoritativeOwner) => {
      expect(classifyApiToolReadOutcome(tool, { tool, currentStatus: 'available' })?.kind).toBe(
        'failed',
      );
      expect(classifyApiToolReadOutcome(tool, { tool, authoritativeOwner })?.kind).toBe('failed');
      const failed = classifyApiToolReadOutcome(tool, {
        tool,
        authoritativeOwner,
        currentStatus: 'error',
        error: 'PRIVATE_OWNER_PAYLOAD',
      });
      expect(failed?.kind).toBe('failed');
      expect(JSON.stringify(failed)).not.toContain('PRIVATE_OWNER_PAYLOAD');
    },
  );

  describe('positive controls - complete', () => {
    it('should classify bill_text complete when all coverage flags true and nextCursor null', () => {
      const result = classifyApiToolReadOutcome('read_bill_text', {
        tool: 'read_bill_text',
        authoritativeOwner: 'federal_evidence_current',
        currentStatus: 'available',
        found: true,
        billId: '119-hr-1',
        versionCode: 'ih',
        versionHash: hash,
        textHash: hash,
        text: 'full bill text',
        coverage: {
          complete: true,
          pageComplete: true,
          contentComplete: true,
          paginationComplete: true,
          truncated: false,
          nextCursor: null,
        },
      });
      expect(result).toEqual({ kind: 'complete' });
    });

    it('should classify scrape_web_page complete when all coverage flags true', () => {
      const result = classifyApiToolReadOutcome('scrape_web_page', {
        tool: 'scrape_web_page',
        authoritativeOwner: 'public_url',
        currentStatus: 'available',
        url: 'https://example.com/',
        finalUrl: 'https://example.com/',
        contentHash: hash,
        text: 'full page content',
        trust: 'external_untrusted',
        coverage: {
          complete: true,
          truncated: false,
          locator: { url: 'https://example.com/' },
        },
      });
      expect(result).toEqual({ kind: 'complete' });
    });

    it('should classify read_monday_client_boards complete when sourceStatus healthy and all flags correct', () => {
      const result = classifyApiToolReadOutcome('read_monday_client_boards', {
        tool: 'read_monday_client_boards',
        authoritativeOwner: 'managed_monday_mcp',
        currentStatus: 'healthy',
        records: [{ recordId: '1', title: 'Test' }],
        coverage: {
          complete: true,
          returned: 1,
          sources: [
            {
              domain: 'monday',
              sourceStatus: 'healthy',
              returned: 1,
              coverageComplete: true,
              paginationComplete: true,
              hasMore: false,
              truncated: false,
            },
          ],
        },
      });
      expect(result).toEqual({ kind: 'complete' });
    });

    it('should classify search_memory complete when all flags true and nextCursor null', () => {
      const result = classifyApiToolReadOutcome('search_memory', {
        tool: 'search_memory',
        contentStatus: 'available',
        contentTruncated: false,
        factContentUnavailableCount: 0,
        nextCursor: null,
        coverage: {
          complete: true,
          paginationComplete: true,
          sources: [
            {
              domain: 'institutional_knowledge',
              sourceStatus: 'healthy',
              hasMore: false,
              truncated: false,
              paginationComplete: true,
              coverageComplete: true,
            },
          ],
        },
        results: [],
        records: [],
      });
      expect(result).toEqual({ kind: 'complete' });
    });

    it('should classify get_research_evidence complete when status=complete and all flags true', () => {
      const result = classifyApiToolReadOutcome('get_research_evidence', {
        tool: 'get_research_evidence',
        authoritativeOwner: 'clio_chat_attachment',
        currentStatus: 'available',
        records: [{ id: '1', title: 'Article' }],
        coverage: {
          status: 'complete',
          complete: true,
          paginationComplete: true,
          truncated: false,
          nextCursor: null,
        },
      });
      expect(result).toEqual({ kind: 'complete' });
    });
  });

  describe('positive controls - healthy empty', () => {
    it('should classify bill_text empty when found=true but no records and nextCursor null', () => {
      const result = classifyApiToolReadOutcome('read_bill_text', {
        tool: 'read_bill_text',
        authoritativeOwner: 'federal_evidence_current',
        currentStatus: 'available',
        found: true,
        billId: '119-hr-1',
        versionCode: 'ih',
        versionHash: hash,
        textHash: hash,
        text: '',
        coverage: {
          complete: true,
          pageComplete: true,
          contentComplete: true,
          paginationComplete: true,
          truncated: false,
          nextCursor: null,
        },
      });
      expect(result).toEqual({ kind: 'empty' });
    });

    it('should classify scrape_web_page empty when text is empty', () => {
      const result = classifyApiToolReadOutcome('scrape_web_page', {
        tool: 'scrape_web_page',
        authoritativeOwner: 'public_url',
        currentStatus: 'available',
        url: 'https://example.com/',
        contentHash: hash,
        text: '',
        trust: 'external_untrusted',
        coverage: {
          complete: true,
          truncated: false,
          locator: { url: 'https://example.com/' },
        },
      });
      expect(result).toEqual({ kind: 'empty' });
    });

    it('should classify read_monday_client_boards empty when records empty and source healthy', () => {
      const result = classifyApiToolReadOutcome('read_monday_client_boards', {
        tool: 'read_monday_client_boards',
        authoritativeOwner: 'managed_monday_mcp',
        currentStatus: 'healthy',
        records: [],
        coverage: {
          complete: true,
          returned: 0,
          sources: [
            {
              domain: 'monday',
              sourceStatus: 'healthy',
              returned: 0,
              coverageComplete: true,
              paginationComplete: true,
              hasMore: false,
              truncated: false,
            },
          ],
        },
      });
      expect(result).toEqual({ kind: 'empty' });
    });

    it('should classify search_memory empty when contentStatus=empty', () => {
      const result = classifyApiToolReadOutcome('search_memory', {
        tool: 'search_memory',
        contentStatus: 'empty',
        contentTruncated: false,
        factContentUnavailableCount: 0,
        nextCursor: null,
        coverage: {
          complete: true,
          paginationComplete: true,
          sources: [
            {
              domain: 'institutional_knowledge',
              sourceStatus: 'healthy',
              hasMore: false,
              truncated: false,
              paginationComplete: true,
              coverageComplete: true,
            },
          ],
        },
        results: [],
        records: [],
      });
      expect(result).toEqual({ kind: 'empty' });
    });

    it('should classify get_research_evidence empty when records empty and status=complete', () => {
      const result = classifyApiToolReadOutcome('get_research_evidence', {
        tool: 'get_research_evidence',
        authoritativeOwner: 'clio_chat_attachment',
        currentStatus: 'available',
        records: [],
        coverage: {
          status: 'complete',
          complete: true,
          paginationComplete: true,
          truncated: false,
          nextCursor: null,
        },
      });
      expect(result).toEqual({ kind: 'empty' });
    });
  });

  describe('negative controls - direct failures', () => {
    it('should classify bill_text partial when pageComplete=false', () => {
      const result = classifyApiToolReadOutcome('read_bill_text', {
        tool: 'read_bill_text',
        authoritativeOwner: 'federal_evidence_current',
        currentStatus: 'available',
        found: true,
        billId: '119-hr-1',
        versionCode: 'ih',
        versionHash: hash,
        textHash: hash,
        text: 'body',
        coverage: {
          complete: true,
          pageComplete: false,
          contentComplete: false,
          paginationComplete: false,
          truncated: false,
          nextCursor: null,
        },
      });
      expect(result).toEqual({
        kind: 'partial',
        reason: 'bill_text_coverage_incomplete',
      });
    });

    it('should classify scrape_web_page partial when finalUrl differs from url', () => {
      const result = classifyApiToolReadOutcome('scrape_web_page', {
        tool: 'scrape_web_page',
        authoritativeOwner: 'public_url',
        currentStatus: 'available',
        url: 'https://example.com/',
        finalUrl: 'https://redirect.com/',
        contentHash: hash,
        text: 'body',
        trust: 'external_untrusted',
        coverage: {
          complete: true,
          truncated: false,
          locator: { url: 'https://example.com/' },
        },
      });
      expect(result).toEqual({
        kind: 'partial',
        reason: 'web_page_redirect_differs_from_locator',
      });
    });

    it('should classify read_monday_client_boards unavailable when sourceStatus=unavailable', () => {
      const result = classifyApiToolReadOutcome('read_monday_client_boards', {
        tool: 'read_monday_client_boards',
        authoritativeOwner: 'managed_monday_mcp',
        currentStatus: 'unavailable',
        records: [{ recordId: '1' }],
        coverage: {
          complete: true,
          returned: 1,
          sources: [
            {
              domain: 'monday',
              sourceStatus: 'unavailable',
              returned: 1,
              coverageComplete: true,
              paginationComplete: true,
              hasMore: false,
              truncated: false,
              stopReason: 'monday_service_unavailable',
            },
          ],
        },
      });
      expect(result).toEqual({
        kind: 'unavailable',
        reason: 'read_monday_client_boards_unavailable',
      });
    });

    it('should classify search_memory partial when nextCursor not null', () => {
      const result = classifyApiToolReadOutcome('search_memory', {
        tool: 'search_memory',
        contentStatus: 'available',
        contentTruncated: false,
        factContentUnavailableCount: 0,
        nextCursor: 'abc123',
        coverage: {
          complete: true,
          paginationComplete: true,
          sources: [
            {
              domain: 'institutional_knowledge',
              sourceStatus: 'healthy',
              hasMore: false,
              truncated: false,
              paginationComplete: true,
              coverageComplete: true,
            },
          ],
        },
        results: [],
        records: [],
      });
      expect(result).toEqual({
        kind: 'partial',
        reason: 'memory_coverage_incomplete',
      });
    });

    it('should classify get_research_evidence partial when status is not complete', () => {
      const result = classifyApiToolReadOutcome('get_research_evidence', {
        tool: 'get_research_evidence',
        authoritativeOwner: 'clio_chat_attachment',
        currentStatus: 'available',
        records: [{ id: '1' }],
        coverage: {
          status: 'partial',
          complete: true,
          paginationComplete: true,
          truncated: false,
          nextCursor: null,
        },
      });
      expect(result).toEqual({
        kind: 'partial',
        reason: 'research_evidence_coverage_incomplete',
      });
    });
  });

  describe('edge cases - missing fields should fail', () => {
    it('should classify bill_text partial when nextCursor is string instead of null', () => {
      const result = classifyApiToolReadOutcome('read_bill_text', {
        tool: 'read_bill_text',
        authoritativeOwner: 'federal_evidence_current',
        currentStatus: 'available',
        found: true,
        billId: '119-hr-1',
        versionCode: 'ih',
        versionHash: hash,
        textHash: hash,
        text: 'body',
        coverage: {
          complete: true,
          pageComplete: true,
          contentComplete: true,
          paginationComplete: true,
          truncated: false,
          nextCursor: 'nextpage',
        },
      });
      expect(result).toEqual({
        kind: 'partial',
        reason: 'bill_text_coverage_incomplete',
      });
    });

    it('should classify get_bill_status unavailable when found=false', () => {
      const result = classifyApiToolReadOutcome('get_bill_status', {
        tool: 'get_bill_status',
        authoritativeOwner: 'congress_bill_status',
        currentStatus: 'available',
        found: false,
      });
      expect(result).toEqual({
        kind: 'unavailable',
        reason: 'bill_status_unavailable',
      });
    });

    it('should classify read_chat_attachments partial when mode=manifest', () => {
      const result = classifyApiToolReadOutcome('read_chat_attachments', {
        tool: 'read_chat_attachments',
        authoritativeOwner: 'clio_chat_attachment',
        currentStatus: 'available',
        coverage: { mode: 'manifest' as any },
        records: [],
      });
      expect(result).toEqual({
        kind: 'partial',
        reason: 'attachment_manifest_is_discovery_only',
      });
    });

    it('should classify get_research_evidence partial when truncated=true', () => {
      const result = classifyApiToolReadOutcome('get_research_evidence', {
        tool: 'get_research_evidence',
        authoritativeOwner: 'clio_chat_attachment',
        currentStatus: 'available',
        records: [{ id: '1' }],
        coverage: {
          status: 'complete',
          complete: true,
          paginationComplete: true,
          truncated: true,
          nextCursor: null,
        },
      });
      expect(result).toEqual({
        kind: 'partial',
        reason: 'research_evidence_coverage_incomplete',
      });
    });

    it('should classify read_monday_client_boards partial when hasMore=true', () => {
      const result = classifyApiToolReadOutcome('read_monday_client_boards', {
        tool: 'read_monday_client_boards',
        authoritativeOwner: 'managed_monday_mcp',
        currentStatus: 'healthy',
        records: [{ recordId: '1' }],
        coverage: {
          complete: true,
          returned: 1,
          sources: [
            {
              domain: 'monday',
              sourceStatus: 'healthy',
              returned: 1,
              coverageComplete: true,
              paginationComplete: true,
              hasMore: true,
              truncated: false,
            },
          ],
        },
      });
      expect(result).toEqual({
        kind: 'partial',
        reason: 'monday_coverage_incomplete',
      });
    });
  });
});
