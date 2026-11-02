import {
  BILL_SEMANTIC_CANDIDATE_LIMIT,
  billTextSearchQuery,
  validateBillTextSearch,
} from './bill-text-query.js';
import { CHUNKER_VERSION } from '../ingestion/bill-text-passages.js';

const semantic = {
  vector: Array.from({ length: 1024 }, (_, i) => Number(i === 0)),
  model: 'test-model',
};

describe('bounded bill semantic query', () => {
  it('bounds the public vector owner before canonical joins and hydrates only shortlisted revision keys', () => {
    const { sql, values } = billTextSearchQuery(
      validateBillTextSearch({
        mode: 'semantic',
        query: 'outpatient licensing',
        jurisdictions: ['FL'],
        kind: 'text',
        fiscalYear: 2026,
      }),
      semantic,
    );
    const [nearest, hydration] = sql.split('), semantic_revision_keys AS MATERIALIZED (');
    expect(nearest).toContain('WITH semantic_candidates AS MATERIALIZED (');
    expect(nearest).toContain('FROM context_embeddings e');
    expect(nearest).not.toMatch(/\bJOIN\b|\bEXISTS\b|FROM documents|FROM bill_text_passage/);
    for (const scope of ['tenant_id', 'client_id', 'owner_user_id'])
      expect(nearest).toContain(`e.${scope} IS NULL`);
    expect(nearest).toContain("e.source_type IN ('bill_passage','state_bill_passage')");
    expect(nearest).toMatch(/e\.model=\$\d+/);
    expect(nearest).toContain("e.metadata_jsonb->>'chunkerVersion'");
    expect(nearest).toContain("e.metadata_jsonb->>'jurisdiction'=ANY(");
    expect(nearest).toMatch(/ORDER BY e\.embedding <=> \$\d+::vector LIMIT \$\d+/);
    for (const kind of ['federal', 'state'])
      expect(hydration).toContain(
        `JOIN semantic_revision_keys k ON k.source_kind='${kind}' AND k.revision_uuid=r.id`,
      );
    expect(hydration).toContain('documents AS MATERIALIZED');
    expect(hydration).toContain("WHERE d.completeness='complete'");
    expect(hydration).toContain('d.fy26');
    expect(hydration).toMatch(/d\.kind=\$\d+/);
    expect(hydration).toContain('e.content_text=p.content_text');
    expect(hydration).toContain(
      "e.content_hash=encode(sha256(convert_to(p.content_text,'UTF8')),'hex')",
    );
    for (const key of ['billId', 'revisionId', 'extractionId', 'structureHash', 'textHash'])
      expect(hydration).toContain(`e.metadata_jsonb->>'${key}'`);
    expect(values).toContain(BILL_SEMANTIC_CANDIDATE_LIMIT);
    expect(values).toContain(CHUNKER_VERSION);
  });

  it('parameterizes cheap scope predicates and retains selective canonical filters after the shortlist', () => {
    const billId = "FL' OR true --";
    const { sql, values } = billTextSearchQuery(
      validateBillTextSearch({
        mode: 'semantic',
        query: 'licensing',
        billId,
        session: '2025',
        version: 'Enrolled',
        status: 'enacted',
        dateBasis: 'action',
        dateFrom: '2025-10-01',
        dateBefore: '2026-10-01',
      }),
      semantic,
    );
    const [nearest, hydration] = sql.split('), semantic_revision_keys AS MATERIALIZED (');
    expect(sql).not.toContain(billId);
    expect(values).toContain(billId);
    expect(nearest).toMatch(/e\.metadata_jsonb->>'billId'=\$\d+/);
    expect(nearest).not.toContain("e.metadata_jsonb->>'jurisdiction'");
    expect(hydration).toMatch(/d\.session=\$\d+/);
    expect(hydration).toMatch(/d\.version=\$\d+ OR d\."versionId"=\$\d+/);
    expect(hydration).toMatch(/d\.status=\$\d+/);
    expect(hydration).toContain('unnest(d."actionDates")');
    expect(hydration).toMatch(/ad\.date<\$\d+/);
    expect(sql).not.toMatch(/SECURITY DEFINER|SET LOCAL|enable_seqscan|enable_indexscan/);
  });

  it('keeps exact and lexical reads independent of the semantic candidate cap', () => {
    for (const request of [
      { mode: 'exact' as const, billId: 'FL-2025-HB1' },
      { mode: 'keyword' as const, query: 'licensing' },
    ]) {
      const { sql, values } = billTextSearchQuery(validateBillTextSearch(request));
      expect(sql).not.toContain('semantic_revision_keys');
      expect(sql).not.toContain('semantic_candidates');
      expect(sql).not.toContain('context_embeddings');
      expect(values).not.toContain(BILL_SEMANTIC_CANDIDATE_LIMIT);
    }
  });
});
