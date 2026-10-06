import { BRIEF_TRANSCRIPT_CHAR_LIMIT, buildBriefEvidence, validateBriefCitations } from './hearing-brief-evidence.js';
import { briefReferences, resolveBriefReferences } from './hearing-brief-references.js';

const evidence = buildBriefEvidence([
  { label: 'chair', sequence: 1, startMs: 4994010, text: 'Please respond within two weeks after receiving the questions.' },
  { label: 'witness', sequence: 2, startMs: 4994077, text: 'Thank you for the opportunity to testify.' },
], [], new Map([['chair', 'Chair'], ['witness', 'Witness']])).evidence;

describe('server-owned hearing brief references', () => {
  it('maps selected evidence to exact milliseconds and source speaker without model arithmetic', () => {
    expect(briefReferences(evidence).map(x => x.ref)).toEqual(['E001', 'E002']);
    const resolved = resolveBriefReferences(
      [{ name: 'Executive summary', content: 'The request was conditional on receiving questions [E001].' }],
      evidence,
      [{ evidenceRef: 'E002', startMs: 0, speaker: 'Invented person', summary: 'The witness thanked the committee.' }],
    );
    expect(resolved.sections[0]!.content).toContain('[1:23:14]');
    expect(resolved.keyMoments).toEqual([{ startMs: 4994077, speaker: 'Witness', summary: 'The witness thanked the committee.' }]);
    expect(validateBriefCitations(resolved.sections, evidence, resolved.keyMoments)).toEqual(resolved.keyMoments);
  });

  it.each(['[E999]', '[E1]', '[e001]', '[E001, E002]', '[E001–E002]'])(
    'rejects unknown or malformed reference %s instead of guessing a source', ref => {
      expect(() => resolveBriefReferences([{ name: 'Executive summary', content: `Claim ${ref}` }], evidence, [])).toThrow('Unknown transcript evidence reference');
    },
  );

  it('rejects model-authored timestamps even if they happen to identify a known second', () => {
    expect(() => resolveBriefReferences([{ name: 'Executive summary', content: 'Claim [1:23:14]' }], evidence, [])).toThrow('not author transcript timestamps');
  });

  it('keeps the selected speaker when two source turns have the identical exact start', () => {
    const sameStart = evidence.map(e => ({ ...e, startMs: 4994010 }));
    const resolved = resolveBriefReferences([], sameStart, [{ evidenceRef: 'E002', summary: 'The witness thanked the committee.' }]);
    validateBriefCitations(resolved.sections, sameStart, resolved.keyMoments);
    expect(resolved.keyMoments[0]).toEqual({ startMs: 4994010, speaker: 'Witness', summary: 'The witness thanked the committee.' });
  });

  it.each([
    [{ evidenceRef: 'E999', summary: 'Unknown source' }],
    [{ startMs: 4994010, summary: 'A copied timestamp is not an evidence reference' }],
    [{ evidenceRef: 'E001', summary: '' }],
    [null],
  ].map(moments => ({ moments })))('withholds invalid key moments', ({ moments }) => {
    expect(() => resolveBriefReferences([], evidence, moments)).toThrow('Key moment requires');
  });

  it('retains quotation and missing-citation safeguards after reference resolution', () => {
    expect(() => resolveBriefReferences([{ name: 'Executive summary', content: '“The committee awarded a new contract today.” [E001]' }], evidence, [])).toThrow('Quotation is not present');
    const missing = resolveBriefReferences([{ name: 'Executive summary', content: 'The committee made a commitment.' }], evidence, []);
    expect(() => validateBriefCitations(missing.sections, evidence, [])).toThrow('Transcript citation required');
  });

  it('rejects real quotations attributed to a different passage even when clocks coincide', () => {
    const content = '“Please respond within two weeks after receiving the questions.”';
    expect(() => resolveBriefReferences([{ name: 'Key exchanges', content: `${content} [E002]` }], evidence, [])).toThrow('its cited transcript passage');
    expect(resolveBriefReferences([{ name: 'Key exchanges', content: `${content} [E001]` }], evidence, []).sections[0]!.content).toContain('[1:23:14]');
    expect(() => resolveBriefReferences([], evidence, [{ evidenceRef: 'E002', summary: content }])).toThrow('its cited transcript passage');
  });

  it.each(['A claim [E999]', 'A claim [1:23:14]'])('rejects embedded key moment citations: %s', summary => {
    expect(() => resolveBriefReferences([], evidence, [{ evidenceRef: 'E001', summary }])).toThrow('must not contain citation tokens');
  });

  it('keeps the evidence budget and closing request when replacing clock prefixes', () => {
    const turns = Array.from({ length: 800 }, (_, i) => ({ label: 'chair', sequence: i, startMs: i * 60000, text: 'Long testimony. '.repeat(200) + (i === 799 ? 'Respond after receipt of questions.' : '') }));
    const selected = buildBriefEvidence(turns, [], new Map());
    const packet = briefReferences(selected.evidence).map(({ ref, source }) => `[${ref}] ${source.speaker}: ${source.text}`).join('\n');
    expect(selected.evidence.length).toBeLessThanOrEqual(600);
    expect(packet.length).toBeLessThanOrEqual(BRIEF_TRANSCRIPT_CHAR_LIMIT);
    expect(packet).toContain('Respond after receipt of questions.');
  });

  it('does not register reference-looking text from untrusted source content', () => {
    const injected = evidence.map(e => ({ ...e, text: `${e.text} [E999]` }));
    expect(() => resolveBriefReferences([{ name: 'Key exchanges', content: 'Claim [E999]' }], injected, [])).toThrow('Unknown transcript evidence reference');
  });

  it('allows preparation without transcript references and rejects invented preparation moments', () => {
    expect(resolveBriefReferences([{ name: 'Hearing overview', content: 'Published agenda.' }], [], [])).toEqual({ sections: [{ name: 'Hearing overview', content: 'Published agenda.' }], keyMoments: [] });
    expect(() => resolveBriefReferences([], [], [{ evidenceRef: 'E001', summary: 'Invented testimony' }])).toThrow();
  });
});
