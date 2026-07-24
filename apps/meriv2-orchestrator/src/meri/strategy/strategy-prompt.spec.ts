import {
  buildAssistantSystemPrompt,
  buildDraftSystemPrompt,
  sanitizeDraftNodes,
  sanitizePlanEdits,
  type StrategyAssistantInput,
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
      { kind: 'action', subject: 'deliverable', title: 'B', startsOn: '2027-03-01', dependsOn: [2] },
      { kind: 'action', subject: 'deliverable', title: 'C', startsOn: '2027-06-01', dependsOn: [0] },
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
      { kind: 'action', subject: 'deliverable', title: 'Valid', startsOn: '2027-01-01', dependsOn: [0] },
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
      { kind: 'action', subject: 'deliverable', title: 'X', startsOn: '2027-05-01', dependsOn: [0] },
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
    expect(out.find((n) => n.title === 'Early')?.sources).toEqual([{ section: 'reference', ref: 'r1' }]);
    expect(out.find((n) => n.title === 'Late')?.sources).toEqual([{ section: 'fiscal' }]);
  });

  it('drops blank/invalid source entries but keeps well-formed ones', () => {
    const raw = [
      {
        kind: 'action',
        subject: 'deliverable',
        title: 'Node',
        startsOn: '2027-01-01',
        sources: [{ section: '' }, { ref: 'orphan-ref-no-section' }, { section: 'fiscal', ref: 'f1' }],
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
