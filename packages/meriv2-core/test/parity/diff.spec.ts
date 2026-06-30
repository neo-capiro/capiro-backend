import { diffResponses, defaultGrader, type ParityFieldPolicy } from './diff';

const POLICY: ParityFieldPolicy[] = [
  { path: 'edits.length', kind: 'deterministic' },
  { path: 'clientId', kind: 'deterministic' },
  { path: 'reply', kind: 'graded' },
];

describe('parity diffResponses', () => {
  it('passes when deterministic fields match and graded fields are both present', () => {
    const off = { edits: [1, 2], clientId: 'c1', reply: 'Here is the answer.' };
    const on = { edits: [9, 8], clientId: 'c1', reply: 'A different but valid answer.' };
    const r = diffResponses('f1', off, on, POLICY);
    expect(r.pass).toBe(true);
    expect(r.checked).toBe(3);
  });

  it('fails when a deterministic field differs (e.g. a scoping-sensitive count)', () => {
    const off = { edits: [1, 2], clientId: 'c1', reply: 'x' };
    const on = { edits: [1], clientId: 'c1', reply: 'x' };
    const r = diffResponses('f2', off, on, POLICY);
    expect(r.pass).toBe(false);
    expect(r.mismatches.map((m) => m.path)).toContain('edits.length');
  });

  it('fails when a deterministic id differs (cross-client guard)', () => {
    const off = { edits: [], clientId: 'c1', reply: 'x' };
    const on = { edits: [], clientId: 'c2', reply: 'x' };
    const r = diffResponses('f3', off, on, POLICY);
    expect(r.pass).toBe(false);
    expect(r.mismatches.map((m) => m.path)).toContain('clientId');
  });

  it('fails a graded field when one side is empty', () => {
    const off = { edits: [], clientId: 'c1', reply: 'a real reply' };
    const on = { edits: [], clientId: 'c1', reply: '' };
    const r = diffResponses('f4', off, on, POLICY);
    expect(r.pass).toBe(false);
    expect(r.mismatches.map((m) => m.path)).toContain('reply');
  });

  it('defaultGrader: same type, strings both non-empty', () => {
    expect(defaultGrader('p', 'a', 'b')).toBe(true);
    expect(defaultGrader('p', 'a', '')).toBe(false);
    expect(defaultGrader('p', 1, 'b')).toBe(false);
    expect(defaultGrader('p', { a: 1 }, { a: 2 })).toBe(true);
  });
});
