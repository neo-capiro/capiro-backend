import {
  EMIT_EXTRACTED_FACTS_TOOL,
  buildStewardSystemPrompt,
  sanitizeConflicts,
  sanitizeExtractedFacts,
  sanitizeExtractedFactsIndexed,
  type StewardExtractInput,
} from './steward-prompt.js';

/*
 * Stage E Steward — pure prompt/sanitize logic. The sanitizers are the first
 * pass ahead of api-strategy's authoritative re-validation: malformed entries
 * are DROPPED (never guessed at), numeric/length bounds are clamped, and
 * conflicts can only index facts that actually survived.
 */

const BASE_INPUT: StewardExtractInput = {
  clientId: 'client-1',
  documentId: 'doc-1',
  templateKey: '02_client_constraints',
  authority: 'client_approved',
  asOf: '2026-07-01',
  content: '## Hard limits\nNo direct Hill outreach before October.',
  refs: [
    {
      ref: 'heading:Hard limits',
      kind: 'heading',
      preview: 'No direct Hill outreach before October.',
    },
    { ref: 'row:Approval matrix:2', kind: 'row', preview: 'External statements | CEO sign-off' },
  ],
  existingFacts: [
    {
      id: 'fact-aaa',
      fact: 'Direct Hill outreach is allowed from September.',
      documentTitle: 'Client constraints (v1)',
      authority: 'working_draft',
      asOf: '2026-05-01',
    },
  ],
};

describe('EMIT_EXTRACTED_FACTS_TOOL — strict schema shape', () => {
  it('is a strict tool with additionalProperties:false at every object level and required arrays', () => {
    expect(EMIT_EXTRACTED_FACTS_TOOL.name).toBe('emit_extracted_facts');
    expect(EMIT_EXTRACTED_FACTS_TOOL.strict).toBe(true);
    const schema = EMIT_EXTRACTED_FACTS_TOOL.input_schema;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['summary', 'facts', 'conflicts']);
    expect(schema.properties.facts.items.additionalProperties).toBe(false);
    expect(schema.properties.conflicts.items.additionalProperties).toBe(false);
    // Nullable-by-omission: authority/asOf are properties but NOT required —
    // the model omits them to mean "inherit the document frontmatter value".
    expect(schema.properties.facts.items.required).toEqual([
      'fact',
      'sourceRef',
      'confidence',
      'citation',
    ]);
    expect(schema.properties.facts.maxItems).toBe(80);
    expect(schema.properties.conflicts.maxItems).toBe(20);
  });
});

describe('sanitizeExtractedFacts', () => {
  it('passes a well-formed fact through, mapping omitted authority/asOf to null', () => {
    const out = sanitizeExtractedFacts([
      {
        fact: 'No direct Hill outreach before October.',
        sourceRef: 'heading:Hard limits',
        confidence: 0.9,
        citation: 'No direct Hill outreach before October.',
      },
    ]);
    expect(out).toEqual([
      {
        fact: 'No direct Hill outreach before October.',
        sourceRef: 'heading:Hard limits',
        authority: null,
        asOf: null,
        confidence: 0.9,
        citation: 'No direct Hill outreach before October.',
      },
    ]);
  });

  it('drops malformed entries (non-object, missing fact/sourceRef, non-numeric confidence)', () => {
    const out = sanitizeExtractedFacts([
      null,
      'not-an-object',
      { sourceRef: 'heading:Hard limits', confidence: 0.5, citation: 'x' }, // no fact
      { fact: 'orphan fact', confidence: 0.5, citation: 'x' }, // no sourceRef
      {
        fact: 'stringy confidence',
        sourceRef: 'heading:Hard limits',
        confidence: 'high',
        citation: 'x',
      },
      {
        fact: 'NaN confidence',
        sourceRef: 'heading:Hard limits',
        confidence: Number.NaN,
        citation: 'x',
      },
      { fact: 'survivor', sourceRef: 'heading:Hard limits', confidence: 1, citation: 'x' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.fact).toBe('survivor');
  });

  it('clamps confidence into 0..1 and fact/citation to their char caps', () => {
    const out = sanitizeExtractedFacts([
      { fact: 'a'.repeat(5000), sourceRef: 'r', confidence: 7, citation: 'c'.repeat(5000) },
      { fact: 'low', sourceRef: 'r', confidence: -3, citation: 'c' },
    ]);
    expect(out[0]!.confidence).toBe(1);
    expect(out[0]!.fact).toHaveLength(2000);
    expect(out[0]!.citation).toHaveLength(1000);
    expect(out[1]!.confidence).toBe(0);
  });

  it('carries an explicitly-set authority/asOf through and returns [] for a non-array', () => {
    const out = sanitizeExtractedFacts([
      {
        fact: 'f',
        sourceRef: 'r',
        authority: 'external_authoritative',
        asOf: '2026-06-15',
        confidence: 0.4,
        citation: 'c',
      },
    ]);
    expect(out[0]).toMatchObject({ authority: 'external_authoritative', asOf: '2026-06-15' });
    expect(sanitizeExtractedFacts(undefined)).toEqual([]);
    expect(sanitizeExtractedFacts({ facts: [] })).toEqual([]);
  });
});

describe('sanitizeConflicts', () => {
  const good = {
    newFactIndex: 0,
    existingFactId: 'fact-aaa',
    material: true,
    rationale: 'contradicts window',
  };
  // Identity map for two surviving facts (no drops).
  const identity2: ReadonlyMap<number, number> = new Map([
    [0, 0],
    [1, 1],
  ]);

  it('passes a well-formed conflict through', () => {
    expect(sanitizeConflicts([good], identity2)).toEqual([good]);
  });

  it('drops conflicts with an unmapped or non-integer newFactIndex', () => {
    const out = sanitizeConflicts(
      [
        good,
        { ...good, newFactIndex: 2 }, // beyond the raw facts → unmapped
        { ...good, newFactIndex: -1 },
        { ...good, newFactIndex: 0.5 },
        { ...good, newFactIndex: '0' },
      ],
      identity2,
    );
    expect(out).toEqual([good]);
  });

  it('drops entries missing existingFactId and non-objects; coerces material to a strict boolean', () => {
    const out = sanitizeConflicts(
      [null, { newFactIndex: 0, material: true, rationale: 'x' }, { ...good, material: 'yes' }],
      identity2,
    );
    expect(out).toEqual([{ ...good, material: false }]);
    expect(sanitizeConflicts('nope', identity2)).toEqual([]);
  });

  it('drops everything when no facts survived (a conflict cannot reference a fact that does not exist)', () => {
    expect(sanitizeConflicts([good], new Map())).toEqual([]);
  });

  it('remaps newFactIndex across a dropped fact instead of silently pairing the wrong survivor', () => {
    // Model emits facts[0] valid, facts[1] whitespace-only fact text (dropped
    // by the sanitizer), facts[2] valid — the returned facts array is
    // ['first', 'third'], so raw index 2 must land on sanitized index 1 and a
    // conflict against the dropped raw index 1 must be dropped with it.
    const { facts, rawIndexToSanitized } = sanitizeExtractedFactsIndexed([
      { fact: 'first', sourceRef: 'heading:Hard limits', confidence: 1, citation: 'a' },
      { fact: '   ', sourceRef: 'heading:Hard limits', confidence: 1, citation: 'b' },
      { fact: 'third', sourceRef: 'row:Approval matrix:2', confidence: 1, citation: 'c' },
    ]);
    expect(facts.map((f) => f.fact)).toEqual(['first', 'third']);
    const out = sanitizeConflicts(
      [
        { ...good, newFactIndex: 2 }, // raw facts[2] → sanitized index 1 ('third')
        { ...good, newFactIndex: 1 }, // raw facts[1] was dropped → conflict goes with it
      ],
      rawIndexToSanitized,
    );
    expect(out).toEqual([{ ...good, newFactIndex: 1 }]);
    expect(facts[out[0]!.newFactIndex]!.fact).toBe('third');
  });
});

describe('buildStewardSystemPrompt', () => {
  it('renders the document content + the CLOSED-SET ref inventory with previews', () => {
    const sys = buildStewardSystemPrompt(BASE_INPUT);
    expect(sys).toContain('No direct Hill outreach before October.');
    expect(sys).toContain('Cite sourceRef ONLY from this list — do not invent anchors');
    expect(sys).toContain('heading:Hard limits');
    expect(sys).toContain('row:Approval matrix:2');
    expect(sys).toContain('External statements | CEO sign-off');
  });

  it('carries the frontmatter authority/asOf and the extraction rules (assumptions, per-row dates, no credentials/PII)', () => {
    const sys = buildStewardSystemPrompt(BASE_INPUT);
    expect(sys).toContain('client_approved');
    expect(sys).toContain('2026-07-01');
    expect(sys).toContain('Separate facts from assumptions');
    expect(sys).toContain('keep the authority from the frontmatter');
    expect(sys).toContain('unless a row carries its own date');
    expect(sys).toContain(
      'NEVER extract credentials, passwords, access tokens, or personal data beyond names and roles',
    );
  });

  it('digests existing facts WITH their ids and states the conflict/materiality rule', () => {
    const sys = buildStewardSystemPrompt(BASE_INPUT);
    expect(sys).toContain('[fact-aaa] Direct Hill outreach is allowed from September.');
    expect(sys).toContain('Flag a conflict ONLY when two facts cannot both be true');
    expect(sys).toContain(
      'material=true when acting on the wrong one would change strategy or embarrass the client',
    );
  });

  it('renders explicit empty-state markers for no refs / no existing facts', () => {
    const sys = buildStewardSystemPrompt({ ...BASE_INPUT, refs: [], existingFacts: [] });
    expect(sys).toContain('(the document exposed no anchors — extract nothing)');
    expect(sys).toContain('(no existing facts on record — the conflicts array must be empty)');
  });
});
