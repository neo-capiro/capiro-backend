import { NotFoundException } from '@nestjs/common';
import type { MeriResultEnvelope } from '@capiro/shared';
import { envelopeResearchEvidenceResult, observeResearchEvidenceCall } from './meri-research-evidence-envelope.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const attachmentId = '22222222-2222-4222-8222-222222222222';
const contentSha256 = 'a'.repeat(64);
const request = { sessionId, attachmentIds: [attachmentId] };

function payload(coverage: Record<string, unknown> = {}, records: unknown[] = []) {
  return {
    tool: 'get_research_evidence',
    sessionId,
    capturedAt: '2026-09-24T18:30:00.000Z',
    coverage: {
      status: 'complete', total: records.length, returned: records.length,
      truncated: false, paginationComplete: true, contentComplete: true,
      complete: true, nextCursor: null,
      ...coverage,
    },
    records,
  };
}

function record(id = attachmentId, hash = contentSha256) {
  return {
    domain: 'research_attachments',
    recordId: id,
    payload: { id, status: 'parsed', contentSha256: hash },
    provenance: { sourceType: 'research_snapshot', sessionId, capturedAt: '2026-09-24T18:30:00.000Z', originalAttachmentId: id },
  };
}

describe('get_research_evidence document result-envelope adapter', () => {
  it('preserves the complete legacy payload and maps only its proven session, attachment, hash, and snapshot time', () => {
    const legacy = payload({}, [record()]);
    const envelope = envelopeResearchEvidenceResult(legacy, request);

    expect(envelope.legacyPayload).toBe(legacy);
    expect(envelope).toMatchObject({ contract: 'meri.result-envelope.v1', outcome: 'succeeded' });
    expect(envelope.sources).toEqual([{
      family: 'document', sourceId: 'research_attachments', availability: 'available',
      scope: { sessionId, attachmentSelection: JSON.stringify([attachmentId]) },
      observedAt: '2026-09-24T18:30:00.000Z',
      coverage: { completeness: 'complete', continuation: { hasMore: false }, returnedCount: 1, matchedCount: 1 },
      provenance: [{ recordId: attachmentId, sourceVersion: contentSha256, observedAt: '2026-09-24T18:30:00.000Z' }],
    }]);
    expect(envelope.sources[0]?.observedAt).not.toBe(new Date().toISOString());
  });

  it('maps partial pages and opaque cursors without declaring completion', () => {
    const nextCursor = 'opaque_cursor_2';
    const legacy = payload({
      status: 'partial', total: 3, returned: 1, truncated: true,
      paginationComplete: false, contentComplete: false, complete: false, nextCursor,
    }, [record()]);
    const envelope = envelopeResearchEvidenceResult(legacy, { sessionId, limit: 1, cursor: 'opaque_cursor_1' });

    expect(envelope.outcome).toBe('partial');
    expect(envelope.truncation.truncated).toBe(true);
    expect(envelope.sources[0]).toMatchObject({
      scope: { sessionId, attachmentSelection: 'all' },
      coverage: { completeness: 'partial', continuation: { hasMore: true, cursor: nextCursor }, returnedCount: 1, matchedCount: 3 },
    });
  });

  it('does not treat a terminal cursor page as whole-snapshot completion', () => {
    const finalPage = payload({
      status: 'complete', total: 3, returned: 2, truncated: false,
      paginationComplete: true, contentComplete: true, complete: true, nextCursor: null,
    }, [record(), record('33333333-3333-4333-8333-333333333333')]);
    const envelope = envelopeResearchEvidenceResult(finalPage, {
      sessionId, limit: 2, cursor: 'opaque_cursor_previous_page',
    });

    expect(finalPage.coverage.complete).toBe(true);
    expect(envelope.outcome).toBe('partial');
    expect(envelope.sources[0]?.coverage.completeness).toBe('partial');
  });

  it('maps explicit handoff unavailability and sanitizes its source reason', () => {
    const legacy = payload({ status: 'unavailable', total: null, returned: 0, truncated: null,
      paginationComplete: undefined, contentComplete: undefined, complete: false, nextCursor: null,
      reason: 'research_handoff_unavailable', note: 'private source detail' }, []);
    const envelope = envelopeResearchEvidenceResult(legacy, { sessionId });

    expect(envelope.outcome).toBe('unavailable');
    expect(envelope.sources[0]).toMatchObject({ availability: 'unavailable', coverage: { completeness: 'unknown' }, failure: { code: 'research_handoff_unavailable' } });
    expect(envelope.errors).toEqual([{ code: 'research_handoff_unavailable' }]);
    expect(JSON.stringify(envelope.sources) + JSON.stringify(envelope.errors)).not.toContain('private source detail');
  });

  it('does not report an empty or malformed payload as complete absence', () => {
    const emptyButProven = envelopeResearchEvidenceResult(payload({ total: 0, returned: 0 }, []), { sessionId });
    expect(emptyButProven.outcome).toBe('not_found_within_scope');

    const missingEvidence = envelopeResearchEvidenceResult({ tool: 'get_research_evidence', sessionId, coverage: { status: 'complete', complete: true, total: 0, returned: 0 } }, { sessionId });
    expect(missingEvidence.outcome).toBe('partial');
    expect(missingEvidence.sources[0]?.coverage.completeness).toBe('unknown');

    const missingSourceIdentity = envelopeResearchEvidenceResult({ ...payload({ total: 0, returned: 0 }, []), tool: 'unexpected_tool' }, { sessionId });
    expect(missingSourceIdentity.outcome).toBe('partial');
    expect(missingSourceIdentity.sources[0]).toMatchObject({ availability: 'unknown', coverage: { completeness: 'unknown' } });
  });

  it('does not infer completion from contradictory counters or an unsupported status', () => {
    const mismatched = envelopeResearchEvidenceResult(payload({ total: 2, returned: 0 }, [record()]), { sessionId });
    expect(mismatched.outcome).toBe('partial');
    expect(mismatched.sources[0]?.coverage.completeness).toBe('partial');

    const unknownStatus = envelopeResearchEvidenceResult(payload({ status: 'future_status', complete: true }, []), { sessionId });
    expect(unknownStatus.outcome).toBe('partial');
    expect(unknownStatus.sources[0]).toMatchObject({ availability: 'unknown', coverage: { completeness: 'unknown' } });
  });

  it('keeps original IDs as provenance only when the source record confirms their identity', () => {
    const forgedOrigin = { ...record(), provenance: { originalAttachmentId: 'other-attachment' } };
    const envelope = envelopeResearchEvidenceResult(payload({}, [forgedOrigin]), { sessionId });
    expect(envelope.sources[0]?.provenance).toEqual([]);
    expect(envelope.legacyPayload.records[0]).toBe(forgedOrigin);
  });

  it('keeps missing and wrong-owner lease failures indistinguishable and rethrows each original object', async () => {
    const observed: MeriResultEnvelope<unknown>[] = [];
    const missing = new NotFoundException('Research session not found');
    const wrongOwner = new NotFoundException('Research session not found');
    for (const error of [missing, wrongOwner]) {
      await expect(observeResearchEvidenceCall(
        async () => { throw error; }, request, (envelope) => observed.push(envelope),
      )).rejects.toBe(error);
    }

    expect(observed).toHaveLength(0);
  });

  it('returns the original success object and keeps the observer opt-in', async () => {
    const legacy = payload({}, [record()]);
    const observed: MeriResultEnvelope<unknown>[] = [];
    const result = await observeResearchEvidenceCall(async () => legacy, request, (envelope) => observed.push(envelope));
    expect(result).toBe(legacy);
    expect(observed[0]?.legacyPayload).toBe(legacy);
  });
});
