import {
  briefTurns,
  buildBriefEvidence,
  validateBriefCitations,
  BRIEF_TRANSCRIPT_CHAR_LIMIT,
} from './hearing-brief-evidence.js';

describe('hearing debrief evidence', () => {
  it('keeps unlabeled speech and splits a long witness statement at real timestamps', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      sequence: i,
      startMs: i * 1000,
      speakerLabel: null,
      text: `passage ${i} ` + 'word '.repeat(100),
    }));
    const turns = briefTurns(rows);
    expect(turns.length).toBeGreaterThan(1);
    expect(turns.map((t) => t.text).join(' ')).toContain('passage 19');
    expect(buildBriefEvidence(turns, [], new Map()).lines[0]).toContain('Unidentified speaker:');
  });

  it('preserves closing testimony under a strict budget even with many early findings', () => {
    const turns = Array.from({ length: 2000 }, (_, i) => ({
      sequence: i,
      label: '0',
      startMs: i * 10000,
      text: `passage ${i} ` + 'word '.repeat(1500),
    }));
    const selected = buildBriefEvidence(
      turns,
      turns.slice(0, 700).map((t) => t.startMs),
      new Map(),
    );
    expect(selected.evidence.at(-1)?.sequence).toBe(1999);
    expect(selected.evidence.some((e) => e.sequence > 1400 && e.sequence < 1600)).toBe(true);
    expect(selected.lines.join('\n').length).toBeLessThanOrEqual(BRIEF_TRANSCRIPT_CHAR_LIMIT);
    expect(selected.coverage.limited).toBe(true);
  });

  it('supplies the full available transcript when it fits', () => {
    const turns = Array.from({ length: 50 }, (_, i) => ({
      sequence: i,
      label: '0',
      startMs: i * 1000,
      text: 'A complete statement.',
    }));
    const result = buildBriefEvidence(turns, [], new Map());
    expect(result.coverage).toEqual({
      availableTurns: 50,
      includedTurns: 50,
      truncatedTurns: 0,
      limited: false,
    });
  });

  it('retains closing deadlines at the end of long hearings within the character budget', () => {
    const turns = Array.from({ length: 2000 }, (_, i) => ({
      sequence: i,
      label: '0',
      startMs: i * 10000,
      text:
        'Routine testimony. '.repeat(100) + (i === 1999 ? ' Please respond within two weeks.' : ''),
    }));
    const selected = buildBriefEvidence(
      turns,
      turns.slice(0, 700).map((t) => t.startMs),
      new Map(),
    );
    expect(selected.evidence.slice(-3).map((e) => e.sequence)).toEqual([1997, 1998, 1999]);
    expect(selected.evidence.at(-1)?.text).toBe(turns.at(-1)?.text);
    expect(selected.lines.join('\n')).toContain('Please respond within two weeks.');
    expect(selected.evidence.length).toBeLessThanOrEqual(600);
    expect(selected.lines.join('\n').length).toBeLessThanOrEqual(BRIEF_TRANSCRIPT_CHAR_LIMIT);
  });

  it('preserves the tail of an oversized closing turn with its real citation anchor', () => {
    const turns = Array.from({ length: 600 }, (_, i) => ({
      sequence: i,
      label: '0',
      startMs: i * 10000,
      text:
        'Routine testimony. '.repeat(1000) + (i === 599 ? ' Please respond within two weeks.' : ''),
    }));
    const selected = buildBriefEvidence(turns, [], new Map());
    const closing = selected.evidence.at(-1)!;
    expect(closing.text).toMatch(/^…/);
    expect(closing.text).toContain('Please respond within two weeks.');
    expect(closing.startMs).toBe(turns.at(-1)?.startMs);
    expect(selected.lines.join('\n').length).toBeLessThanOrEqual(BRIEF_TRANSCRIPT_CHAR_LIMIT);
    expect(selected.coverage.truncatedTurns).toBe(600);
    expect(() =>
      validateBriefCitations(
        [
          {
            name: 'Commitments, deadlines and open questions',
            content: '“Please respond within two weeks.” [1:39:50]',
          },
        ],
        selected.evidence,
        [{ startMs: closing.startMs, summary: 'Requested responses within two weeks.' }],
      ),
    ).not.toThrow();
  });

  it('does not shorten a long closing turn when the full transcript fits', () => {
    const text = 'A recorded statement. '.repeat(1000) + ' The hearing is adjourned.';
    const selected = buildBriefEvidence(
      [{ label: '0', sequence: 1, startMs: 0, text }],
      [],
      new Map(),
    );
    expect(selected.evidence[0]?.text).toBe(text);
    expect(selected.coverage.limited).toBe(false);
  });

  it('rejects invented timestamps and derives key-moment speakers from the source', () => {
    const selected = buildBriefEvidence(
      [{ sequence: 1, label: '0', startMs: 5000, text: 'We will provide a report.' }],
      [],
      new Map([['0', 'Witness A']]),
    );
    expect(() =>
      validateBriefCitations(
        [{ name: 'Key exchanges', content: 'A claim [99:59].' }],
        selected.evidence,
        [],
      ),
    ).toThrow('Unverified');
    expect(() =>
      validateBriefCitations(
        [{ name: 'Executive summary', content: 'A claim without evidence.' }],
        selected.evidence,
        [],
      ),
    ).toThrow('citation required');
    expect(() =>
      validateBriefCitations([], selected.evidence, [
        { startMs: 9999, summary: 'Wrong timestamp' },
      ]),
    ).toThrow('outside');
    expect(() =>
      validateBriefCitations(
        [
          {
            name: 'Key exchanges',
            content: 'The witness said “We will double the appropriation.” [00:05]',
          },
        ],
        selected.evidence,
        [],
      ),
    ).toThrow('Quotation');
    expect(
      validateBriefCitations(
        [{ name: 'Key exchanges', content: 'Report commitment [00:05].' }],
        selected.evidence,
        [{ startMs: 5000, speaker: 'Invented name', summary: 'Report commitment' }],
      ),
    ).toEqual([{ startMs: 5000, speaker: 'Witness A', summary: 'Report commitment' }]);
  });
});
