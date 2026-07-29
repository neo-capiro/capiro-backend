import {
  STEWARD_FACTS_SECTION,
  PROPOSE_DOCUMENT_DRAFT_TOOL,
  PROPOSE_STRATEGY_DRAFT_TOOL,
  buildAssistantSystemPrompt,
  buildDocumentDraftSystemPrompt,
  buildDraftSystemPrompt,
  renderStewardFacts,
  sanitizeDocumentSections,
  sanitizeDraftNodes,
  sanitizePlanEdits,
  type StewardFactLite,
  type StrategyAssistantInput,
  type StrategyDocumentDraftInput,
  type StrategyDraftInput,
} from './strategy-prompt.js';

/*
 * Attachment grounding (CRT-5 / MRI-7): user-uploaded document text, resolved by
 * api-strategy and forwarded here, must land in the system prompt so Meri
 * actually grounds on it (the whole point of the "Start from a document" path).
 */
describe('strategy-prompt — attachment grounding (CRT-5/MRI-7)', () => {
  it('renders attached document text in the draft system prompt', () => {
    const input = {
      clientId: 'c1',
      type: 'appropriations',
      goal: 'Win the plus-up',
      attachments: [{ filename: 'memo.pdf', text: 'FY27 shipbuilding priorities' }],
    } as StrategyDraftInput;
    const sys = buildDraftSystemPrompt(input, '(pack)');
    expect(sys).toContain('# Attached documents');
    expect(sys).toContain('memo.pdf');
    expect(sys).toContain('FY27 shipbuilding priorities');
  });

  it('omits the attachments section when none are provided', () => {
    const input = { clientId: 'c1', type: 'appropriations', goal: 'g' } as StrategyDraftInput;
    expect(buildDraftSystemPrompt(input, '(pack)')).not.toContain('# Attached documents');
  });

  it('renders attached document text in the assistant system prompt', () => {
    const input = {
      scope: 'strategy',
      instruction: 'incorporate the memo',
      clientId: 'c1',
      strategy: { id: 's1', title: 'Plan', type: 'appropriations', nodes: [] },
      attachments: [{ filename: 'brief.docx', text: 'coalition sign-on plan' }],
    } as StrategyAssistantInput;
    const sys = buildAssistantSystemPrompt(input, '(pack)');
    expect(sys).toContain('# Attached documents');
    expect(sys).toContain('brief.docx');
    expect(sys).toContain('coalition sign-on plan');
  });
});

/*
 * A3: dependsOn coming off the wire is 0-based indexes into the node array AS THE
 * MODEL RETURNED IT. sanitizeDraftNodes filters, sorts by startsOn, and truncates —
 * all of which change array positions — so dependsOn must be remapped from
 * "original position" to "final position" or edges silently attach to the wrong
 * node. These tests fail against the old (unfixed) pass-through implementation.
 */
describe('sanitizeDraftNodes — dependsOn index remap (A3)', () => {
  it('remaps dependsOn through a sort that reorders nodes, preserving the logical edge', () => {
    // Model returns nodes out of date order. B (original index 0) depends on A
    // (original index 2). C (original index 1) depends on B (original index 0).
    const raw = [
      {
        kind: 'action',
        subject: 'deliverable',
        title: 'B',
        startsOn: '2027-03-01',
        dependsOn: [2],
      },
      {
        kind: 'action',
        subject: 'deliverable',
        title: 'C',
        startsOn: '2027-06-01',
        dependsOn: [0],
      },
      { kind: 'action', subject: 'deliverable', title: 'A', startsOn: '2027-01-01' },
    ];

    const out = sanitizeDraftNodes(raw);

    // After sort-by-startsOn, final order is A, B, C.
    expect(out.map((n) => n.title)).toEqual(['A', 'B', 'C']);
    const finalIndexOf = (title: string) => out.findIndex((n) => n.title === title);

    // B must still depend on A — by A's FINAL position, not A's stale original index (2).
    expect(out[finalIndexOf('B')]!.dependsOn).toEqual([finalIndexOf('A')]);
    // C must still depend on B — by B's FINAL position, not B's stale original index (0).
    expect(out[finalIndexOf('C')]!.dependsOn).toEqual([finalIndexOf('B')]);
  });

  it('drops a dependsOn reference to a node that gets filtered out (missing required fields)', () => {
    const raw = [
      // Invalid: no kind/subject/startsOn — dropped by the required-field filter.
      { title: 'incomplete' },
      {
        kind: 'action',
        subject: 'deliverable',
        title: 'Valid',
        startsOn: '2027-01-01',
        dependsOn: [0],
      },
    ];

    const out = sanitizeDraftNodes(raw);

    expect(out).toHaveLength(1);
    expect(out[0]!.title).toBe('Valid');
    // The dangling reference must be dropped, not left pointing at whatever now
    // occupies index 0 in the final array.
    expect(out[0]!.dependsOn).toEqual([]);
  });

  it('drops a self-reference after remap, even when sorting moves the node', () => {
    const raw = [
      // Later-dated node references its OWN original index (0).
      {
        kind: 'action',
        subject: 'deliverable',
        title: 'X',
        startsOn: '2027-05-01',
        dependsOn: [0],
      },
      { kind: 'action', subject: 'deliverable', title: 'Y', startsOn: '2027-01-01' },
    ];

    const out = sanitizeDraftNodes(raw);

    // Sort moves X to final index 1; its self-reference must still be recognized
    // and dropped (not misread as a dependency on Y, which now sits at index 0).
    expect(out.map((n) => n.title)).toEqual(['Y', 'X']);
    expect(out.find((n) => n.title === 'X')?.dependsOn).toEqual([]);
  });
});

/*
 * A9: per-node provenance (`sources`) must survive the same filter/sort/slice
 * pipeline that dependsOn goes through above, staying attached to the correct
 * node rather than the correct ARRAY POSITION.
 */
describe('sanitizeDraftNodes — sources provenance (A9)', () => {
  it('keeps sources attached to the correct node through filter/sort/slice', () => {
    const raw = [
      {
        kind: 'action',
        subject: 'deliverable',
        title: 'Late',
        startsOn: '2027-06-01',
        sources: [{ section: 'fiscal' }],
      },
      // Dropped by the required-field filter; its sources must not leak onto a survivor.
      { title: 'incomplete', sources: [{ section: 'should-be-dropped-with-node' }] },
      {
        kind: 'action',
        subject: 'deliverable',
        title: 'Early',
        startsOn: '2027-01-01',
        sources: [{ section: 'reference', ref: 'r1' }],
      },
    ];

    const out = sanitizeDraftNodes(raw);

    // Sort-by-startsOn reorders the array; sources must follow their own node, not the slot.
    expect(out.map((n) => n.title)).toEqual(['Early', 'Late']);
    expect(out.find((n) => n.title === 'Early')?.sources).toEqual([
      { section: 'reference', ref: 'r1' },
    ]);
    expect(out.find((n) => n.title === 'Late')?.sources).toEqual([{ section: 'fiscal' }]);
  });

  it('drops blank/invalid source entries but keeps well-formed ones', () => {
    const raw = [
      {
        kind: 'action',
        subject: 'deliverable',
        title: 'Node',
        startsOn: '2027-01-01',
        sources: [
          { section: '' },
          { ref: 'orphan-ref-no-section' },
          { section: 'fiscal', ref: 'f1' },
        ],
      },
    ];

    const out = sanitizeDraftNodes(raw);

    expect(out[0]!.sources).toEqual([{ section: 'fiscal', ref: 'f1' }]);
  });
});

/*
 * A9: coherent truncation, mirroring sanitizeDraftNodes — a batch over the 60-edit
 * cap must not silently drop whichever edit happened to land last in the model's
 * JSON. Edits without a startsOn (e.g. `remove`) must survive the cut alongside
 * the earliest-dated ops, not be arbitrarily dropped because of their position.
 */
describe('sanitizePlanEdits — coherent truncation (A9)', () => {
  it('keeps a dateless `remove` op over a later-dated op when the batch exceeds the cap', () => {
    const removeOp = { op: 'remove', nodeId: 'stale-gate' };
    // 60 dated `add` ops, all dated AFTER the remove would have needed to survive
    // an arbitrary tail-drop — the remove has no startsOn, so under naive
    // slice(0, 60) it would only survive if it happened to be early in raw order.
    const dated = Array.from({ length: 60 }, (_, i) => ({
      op: 'add' as const,
      kind: 'action',
      subject: 'deliverable',
      title: `Step ${i}`,
      startsOn: `2027-01-${String((i % 28) + 1).padStart(2, '0')}`,
    }));
    // Place the remove LAST in raw order — the position most likely to be
    // silently dropped by a naive slice(0, 60) with no sort.
    const raw = [...dated, removeOp];

    const out = sanitizePlanEdits(raw);

    expect(out).toHaveLength(60);
    expect(out.some((e) => e.op === 'remove' && e.nodeId === 'stale-gate')).toBe(true);
  });

  it('keeps the earliest-dated ops over later-dated ones when truncating', () => {
    const base = new Date('2027-01-01T00:00:00Z');
    // 61 strictly-increasing, unique startsOn values — one over the cap.
    const dated = Array.from({ length: 61 }, (_, i) => {
      const d = new Date(base);
      d.setUTCDate(d.getUTCDate() + i);
      return { op: 'retime' as const, nodeId: `n${i}`, startsOn: d.toISOString().slice(0, 10) };
    });

    const out = sanitizePlanEdits(dated);

    expect(out).toHaveLength(60);
    // The single latest-dated op (n60) must be the one dropped, not an arbitrary one.
    expect(out.some((e) => e.nodeId === 'n60')).toBe(false);
    expect(out.some((e) => e.nodeId === 'n0')).toBe(true);
  });
});

describe('sanitizePlanEdits — sources provenance (A9)', () => {
  it('normalizes a well-formed sources array on an edit op', () => {
    const raw = [
      {
        op: 'update',
        nodeId: 'n1',
        sources: [{ section: 'fiscal', ref: 'f1' }],
      },
    ];

    const out = sanitizePlanEdits(raw);

    expect(out[0]!.sources).toEqual([{ section: 'fiscal', ref: 'f1' }]);
  });

  it('preserves an explicit empty sources array so the assistant can clear provenance', () => {
    const raw = [{ op: 'update', nodeId: 'n1', sources: [] }];

    const out = sanitizePlanEdits(raw);

    // An explicit [] must round-trip as [] (clears provenance) — it must not be
    // conflated with the model simply not sending a sources field at all.
    expect(out[0]!.sources).toEqual([]);
  });

  it('omits the sources key entirely when the edit does not include a sources field', () => {
    const raw = [{ op: 'update', nodeId: 'n1', title: 'New title' }];

    const out = sanitizePlanEdits(raw);

    expect(out[0]).not.toHaveProperty('sources');
  });
});

/*
 * Stage E wire contract (2): api-strategy forwards Steward-curated facts; both
 * system prompts must render the '# Client context facts (Steward)' section
 * with one '- [fact:<id>] ...' line per fact and instruct citing them via
 * {section, ref:'fact:<id>'} — and omit the section entirely when no facts
 * were forwarded (backward compat).
 */
describe('strategy-prompt — Steward facts section (Stage E)', () => {
  const fact = (over: Partial<StewardFactLite>): StewardFactLite => ({
    id: 'f1',
    fact: 'No direct Hill outreach before October.',
    sourceRef: 'heading:Hard limits',
    documentTitle: 'Client constraints',
    templateKey: '02_client_constraints',
    authority: 'client_approved',
    asOf: '2026-07-01',
    ...over,
  });

  it('renders one [fact:<id>] line per fact with authority + asOf in the draft prompt', () => {
    const input = {
      clientId: 'c1',
      type: 'appropriations',
      goal: 'g',
      stewardFacts: [fact({})],
    } as StrategyDraftInput;
    const sys = buildDraftSystemPrompt(input, '(pack)');
    expect(sys).toContain(`# ${STEWARD_FACTS_SECTION}`);
    expect(sys).toContain(
      '- [fact:f1] No direct Hill outreach before October. (client_approved, as of 2026-07-01)',
    );
    // The citing instruction pairs the section name with the fact:<id> ref shape.
    expect(sys).toContain(`{section: "${STEWARD_FACTS_SECTION}", ref: "fact:<id>"}`);
  });

  it('falls back to unattributed/undated for null authority/asOf', () => {
    const input = {
      clientId: 'c1',
      type: 'appropriations',
      stewardFacts: [fact({ id: 'f9', authority: null, asOf: null })],
    } as StrategyDraftInput;
    const sys = buildDraftSystemPrompt(input, '(pack)');
    expect(sys).toContain(
      '- [fact:f9] No direct Hill outreach before October. (unattributed, as of undated)',
    );
  });

  it('omits the section entirely when stewardFacts is absent or empty', () => {
    const bare = { clientId: 'c1', type: 'appropriations' } as StrategyDraftInput;
    expect(buildDraftSystemPrompt(bare, '(pack)')).not.toContain(STEWARD_FACTS_SECTION);
    const empty = { ...bare, stewardFacts: [] } as StrategyDraftInput;
    expect(buildDraftSystemPrompt(empty, '(pack)')).not.toContain(STEWARD_FACTS_SECTION);
  });

  it('renders the section in the assistant prompt too', () => {
    const input = {
      scope: 'strategy',
      instruction: 'push the memo step',
      clientId: 'c1',
      strategy: { id: 's1', title: 'Plan', type: 'appropriations', nodes: [] },
      stewardFacts: [fact({})],
    } as StrategyAssistantInput;
    const sys = buildAssistantSystemPrompt(input, '(pack)');
    expect(sys).toContain(`# ${STEWARD_FACTS_SECTION}`);
    expect(sys).toContain('- [fact:f1]');
  });

  it('sorts required-template facts first, then newest asOf (undated last)', () => {
    const rendered = renderStewardFacts([
      fact({ id: 'undated-opt', templateKey: '08_evidence_register', asOf: null }),
      fact({ id: 'old-opt', templateKey: '08_evidence_register', asOf: '2026-01-01' }),
      fact({ id: 'new-opt', templateKey: '08_evidence_register', asOf: '2026-07-01' }),
      fact({ id: 'old-req', templateKey: '01_strategy_brief', asOf: '2026-02-01' }),
      fact({ id: 'new-req', templateKey: '03_ask_and_options', asOf: '2026-06-01' }),
    ]);
    const order = [...rendered.matchAll(/\[fact:([\w-]+)\]/g)].map((m) => m[1]);
    expect(order).toEqual(['new-req', 'old-req', 'new-opt', 'old-opt', 'undated-opt']);
  });

  it('token-budgets the section (~2000 tokens) so a huge fact list cannot blow the prompt', () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      fact({ id: `f${i}`, fact: 'x'.repeat(200), templateKey: '08_evidence_register' }),
    );
    const rendered = renderStewardFacts(many);
    // 200 facts × ~230 chars ≫ the cap; the render must be truncated well below the raw size.
    expect(rendered.length).toBeLessThanOrEqual(2000 * 4);
  });
});

/*
 * Stage-G grounded content generation: sanitizeDocumentSections is the
 * orchestrator's FIRST-PASS sanitizer for propose_document_draft's `sections`
 * (api-strategy's sanitizeSectionHtml is authoritative) — coerce to array,
 * drop entries missing heading/html, cap section count + per-section length,
 * and best-effort strip disallowed tags/scripts/event handlers.
 */
describe('sanitizeDocumentSections (Stage-G first-pass sanitizer)', () => {
  it('keeps well-formed sections with heading, html, and sources', () => {
    const raw = [
      { heading: 'Background', html: '<p>Context here.</p>', sources: [{ section: 'fiscal' }] },
      { heading: 'The Ask', html: '<p>We ask for X.</p>' },
    ];
    const out = sanitizeDocumentSections(raw);
    expect(out).toEqual([
      { heading: 'Background', html: '<p>Context here.</p>', sources: [{ section: 'fiscal' }] },
      { heading: 'The Ask', html: '<p>We ask for X.</p>' },
    ]);
  });

  it('drops entries with no heading, no html, or blank html', () => {
    const raw = [
      { heading: '', html: '<p>x</p>' },
      { heading: 'No body', html: '' },
      { heading: 'Whitespace only', html: '   ' },
      { html: '<p>no heading key at all</p>' },
      { heading: 'Keeper', html: '<p>survives</p>' },
    ];
    const out = sanitizeDocumentSections(raw);
    expect(out).toEqual([{ heading: 'Keeper', html: '<p>survives</p>' }]);
  });

  it('caps section count at 12, preserving order', () => {
    const raw = Array.from({ length: 20 }, (_, i) => ({ heading: `H${i}`, html: `<p>${i}</p>` }));
    const out = sanitizeDocumentSections(raw);
    expect(out).toHaveLength(12);
    expect(out.map((s) => s.heading)).toEqual(Array.from({ length: 12 }, (_, i) => `H${i}`));
  });

  it('caps per-section HTML length', () => {
    const raw = [{ heading: 'Huge', html: `<p>${'x'.repeat(20_000)}</p>` }];
    const out = sanitizeDocumentSections(raw);
    expect(out[0]!.html.length).toBeLessThanOrEqual(8_000);
  });

  it('strips script/style blocks and event-handler attributes (best-effort first pass)', () => {
    const raw = [
      {
        heading: 'Malicious',
        html: '<p onclick="steal()">safe text</p><script>alert(1)</script><style>body{}</style>',
      },
    ];
    const out = sanitizeDocumentSections(raw);
    expect(out[0]!.html).not.toContain('onclick');
    expect(out[0]!.html).not.toContain('<script>');
    expect(out[0]!.html).not.toContain('<style>');
    expect(out[0]!.html).toContain('safe text');
  });

  it('strips disallowed tags but keeps their inner text', () => {
    const raw = [{ heading: 'Div wrapper', html: '<div><p>kept</p></div>' }];
    const out = sanitizeDocumentSections(raw);
    expect(out[0]!.html).not.toContain('<div>');
    expect(out[0]!.html).toContain('<p>kept</p>');
  });

  it('returns [] for a non-array input', () => {
    expect(sanitizeDocumentSections(null)).toEqual([]);
    expect(sanitizeDocumentSections('not an array')).toEqual([]);
    expect(sanitizeDocumentSections(undefined)).toEqual([]);
  });
});

describe('buildDocumentDraftSystemPrompt (Stage-G)', () => {
  const baseInput = (
    over: Partial<StrategyDocumentDraftInput> = {},
  ): StrategyDocumentDraftInput => ({
    clientId: 'c1',
    kind: 'workspace_draft',
    type: 'appropriations',
    goal: 'Win the plus-up',
    node: { id: 'n1', kind: 'action', subject: 'deliverable', title: 'Draft testimony' },
    ...over,
  });

  it('frames a workspace_draft as a full document to write', () => {
    const sys = buildDocumentDraftSystemPrompt(baseInput(), '(pack)');
    expect(sys).toContain('WORKSPACE DOCUMENT');
    expect(sys).toContain('Draft testimony');
    expect(sys).toContain('propose_document_draft');
  });

  it('frames an outreach_record as a staged-only campaign message, never sent', () => {
    const sys = buildDocumentDraftSystemPrompt(baseInput({ kind: 'outreach_record' }), '(pack)');
    expect(sys).toContain('OUTREACH CAMPAIGN MESSAGE');
    expect(sys).toMatch(/never be sent/i);
  });

  it('includes the strategy goal as a steering signal', () => {
    const sys = buildDocumentDraftSystemPrompt(
      baseInput({ goal: 'Secure the FY28 line increase' }),
      '(pack)',
    );
    expect(sys).toContain('Secure the FY28 line increase');
  });

  it('surfaces the grounding-health note when degraded', () => {
    const sys = buildDocumentDraftSystemPrompt(
      baseInput(),
      '(pack)',
      'Some context could not be loaded.',
    );
    expect(sys).toContain('# Grounding health');
    expect(sys).toContain('Some context could not be loaded.');
  });
});


describe('strategy-prompt — Phase 4 assurance', () => {
  it('does not manufacture an unstated objective and includes the shared assurance contract', () => {
    const sys = buildDraftSystemPrompt(
      { clientId: 'c1', type: 'state appropriations', goal: null } as StrategyDraftInput,
      '(pack)',
    );
    expect(sys).toContain('<government_affairs_assurance version="1">');
    expect(sys).toContain('do not invent one');
    expect(sys).not.toContain('infer a reasonable objective');
  });

  it('requires provenance for fresh nodes and document sections', () => {
    // Read the real `as const` schemas directly rather than asserting a shape onto
    // them: a cast here would blind the compiler to a schema restructure, which is
    // precisely the regression this test exists to catch.
    expect(PROPOSE_STRATEGY_DRAFT_TOOL.input_schema.properties.nodes.items.required).toContain(
      'sources',
    );
    expect(PROPOSE_DOCUMENT_DRAFT_TOOL.input_schema.properties.sections.items.required).toContain(
      'sources',
    );
  });
});
