import {
  MEMORY_CATALOG,
  fileDefForType,
  editableSectionKeys,
  skeletonSections,
  mergeEditedSections,
} from './memory-catalog.js';
import {
  buildInterviewQuestions,
  answersToSections,
  phraseQuestion,
  interviewerSystemPrompt,
} from './memory-interview.helpers.js';

describe('memory catalog', () => {
  it('defines the core firm + client files', () => {
    const types = MEMORY_CATALOG.map((f) => f.type);
    expect(types).toEqual(
      expect.arrayContaining([
        'firm-soul',
        'firm-compass',
        'playbook',
        'client-soul',
        'client-compass',
        'client-people',
      ]),
    );
  });

  it('every section has heading, prompt, and example (help text source)', () => {
    for (const file of MEMORY_CATALOG) {
      for (const s of file.sections) {
        expect(s.key).toBeTruthy();
        expect(s.heading).toBeTruthy();
        expect(s.prompt).toBeTruthy();
        expect(s.example).toBeTruthy();
      }
    }
  });

  it('fileDefForType resolves and editableSectionKeys lists all section keys', () => {
    const def = fileDefForType('client-soul');
    expect(def?.scope).toBe('client');
    const keys = editableSectionKeys('client-soul');
    expect(keys.has('strategic-read')).toBe(true);
    expect(keys.has('not-a-key')).toBe(false);
  });

  it('returns empty allowlist for unknown type (write-guard fail-closed)', () => {
    expect(editableSectionKeys('nope').size).toBe(0);
  });

  it('defines user-scope files including a writing-style file with a samples section', () => {
    const userFiles = MEMORY_CATALOG.filter((f) => f.scope === 'user');
    expect(userFiles.map((f) => f.type)).toEqual(
      expect.arrayContaining(['user-profile', 'user-voice']),
    );
    const voice = fileDefForType('user-voice');
    expect(voice?.sections.map((s) => s.key)).toContain('samples');
  });

  it('skeletonSections returns blank human-owned sections for a type', () => {
    const sk = skeletonSections('user-voice');
    expect(sk.length).toBeGreaterThan(0);
    expect(sk.every((s) => s.owner === 'human' && s.body === '')).toBe(true);
    expect(skeletonSections('unknown-type')).toEqual([]);
  });
});

describe('mergeEditedSections (Settings → Memory save)', () => {
  const allowed = editableSectionKeys('client-soul');

  it('saves an edit to a brand-new file (no existing row)', () => {
    const merged = mergeEditedSections(
      'client-soul',
      null,
      [{ key: 'strategic-read', body: 'Honest read.' }],
      allowed,
    );
    expect(merged.find((s) => s.key === 'strategic-read')?.body).toBe('Honest read.');
    // every catalog section is present + saveable
    expect(merged.map((s) => s.key)).toEqual(
      fileDefForType('client-soul')!.sections.map((s) => s.key),
    );
  });

  it('REGRESSION: saves an edit to a catalog section MISSING from a stale stored row', () => {
    // Stored item only has one section (created before catalog grew / partial
    // ingestion). The old merge walked existing.sections only and silently
    // dropped edits to any absent section — this is the "some files don't save" bug.
    const staleExisting = [
      {
        key: 'who-they-are',
        heading: 'Who they are & what they do',
        owner: 'human' as const,
        body: 'A shipbuilder.',
      },
    ];
    const merged = mergeEditedSections(
      'client-soul',
      staleExisting,
      [{ key: 'red-lines', body: 'Never lobby against the Jones Act.' }],
      allowed,
    );
    // the previously-absent section now exists AND carries the saved edit
    expect(merged.find((s) => s.key === 'red-lines')?.body).toBe(
      'Never lobby against the Jones Act.',
    );
    // the existing section is preserved
    expect(merged.find((s) => s.key === 'who-they-are')?.body).toBe('A shipbuilder.');
  });

  it('never overwrites engine-owned sections', () => {
    const existing = [
      {
        key: 'strategic-read',
        heading: 'Our strategic read',
        owner: 'engine' as const,
        body: 'AUTO',
      },
    ];
    const merged = mergeEditedSections(
      'client-soul',
      existing,
      [{ key: 'strategic-read', body: 'human attempt' }],
      allowed,
    );
    expect(merged.find((s) => s.key === 'strategic-read')?.body).toBe('AUTO');
  });

  it('ignores edits to keys not in the allowlist (write-guard)', () => {
    const merged = mergeEditedSections(
      'client-soul',
      null,
      [{ key: 'not-a-key', body: 'x' }],
      allowed,
    );
    expect(merged.find((s) => s.key === 'not-a-key')).toBeUndefined();
  });

  it('preserves stored sections the catalog no longer lists', () => {
    const existing = [
      { key: 'legacy-section', heading: 'Legacy', owner: 'human' as const, body: 'keep me' },
    ];
    const merged = mergeEditedSections('client-soul', existing, [], allowed);
    expect(merged.find((s) => s.key === 'legacy-section')?.body).toBe('keep me');
  });
});

describe('memory interview helpers', () => {
  it('builds one question per section, in catalog order', () => {
    const qs = buildInterviewQuestions('client-soul');
    const def = fileDefForType('client-soul')!;
    expect(qs).toHaveLength(def.sections.length);
    expect(qs[0]?.sectionKey).toBe(def.sections[0]?.key);
    expect(qs[0]?.question).toContain(def.sections[0]?.heading);
  });

  it('phraseQuestion turns a prompt into a single question', () => {
    const q = phraseQuestion({
      key: 'k',
      heading: 'Red lines',
      prompt: 'Hard constraints we must not cross.',
      example: 'x',
    });
    expect(q.endsWith('?')).toBe(true);
    expect(q).not.toContain('??');
  });

  it('maps answers to human-owned sections, skipping blanks, in order', () => {
    const sections = answersToSections('client-soul', [
      { sectionKey: 'priorities', answer: '  Real: protect the supplemental.  ' },
      { sectionKey: 'who-they-are', answer: 'A shipbuilder.' },
      { sectionKey: 'red-lines', answer: '   ' }, // blank -> skipped
    ]);
    // order follows catalog: who-they-are before priorities
    expect(sections.map((s) => s.key)).toEqual(['who-they-are', 'priorities']);
    expect(sections.every((s) => s.owner === 'human')).toBe(true);
    expect(sections[1]?.body).toBe('Real: protect the supplemental.'); // trimmed
  });

  it('returns no sections for an unknown type', () => {
    expect(answersToSections('nope', [{ sectionKey: 'x', answer: 'y' }])).toEqual([]);
  });

  it('interviewer system prompt encodes the no-invented-stats rule', () => {
    const p = interviewerSystemPrompt('Client Soul');
    expect(p).toContain('Client Soul');
    expect(p.toLowerCase()).toContain('never invent');
  });
});
