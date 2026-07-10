import { commentDeadlineDedupeKey } from './comment-deadline.util.js';

describe('commentDeadlineDedupeKey (Phase 1 M3.4, PD4)', () => {
  it('is stable for the same (source, documentId, clientId) tuple', () => {
    const a = commentDeadlineDedupeKey('federal_register', 'doc-1', 'client-1');
    const b = commentDeadlineDedupeKey('federal_register', 'doc-1', 'client-1');
    expect(a).toBe(b);
  });
  it('differs by source, so a federal and a state doc with coincidentally equal ids never collide', () => {
    const federal = commentDeadlineDedupeKey('federal_register', 'doc-1', 'client-1');
    const state = commentDeadlineDedupeKey('state_register', 'doc-1', 'client-1');
    expect(federal).not.toBe(state);
  });
  it('differs by documentId and by clientId', () => {
    const base = commentDeadlineDedupeKey('federal_register', 'doc-1', 'client-1');
    expect(commentDeadlineDedupeKey('federal_register', 'doc-2', 'client-1')).not.toBe(base);
    expect(commentDeadlineDedupeKey('federal_register', 'doc-1', 'client-2')).not.toBe(base);
  });
});
