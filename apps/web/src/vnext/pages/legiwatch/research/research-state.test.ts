import { afterEach, expect, test } from 'vitest';
import {
  researchDraftKey,
  readResearchDraft,
  writeResearchDraft,
  passageSourceUrl,
} from './research-state.js';
afterEach(() => sessionStorage.clear());
test('recovery is isolated by authenticated user, tenant, private scope and both revisions', () => {
  const params = new URLSearchParams(
    'folder=one&client=client-a&left=id-a&leftRevision=hash-a&right=id-b&rightRevision=hash-b',
  );
  const key = researchDraftKey('tenant:user-a', params);
  writeResearchDraft(key, {
    analysis: 'Private interpretation',
    pending: { hash: 'request-hash', key: 'request-key' },
    saved: { selectionId: 'selection-id' },
  });
  expect(readResearchDraft(key).analysis).toBe('Private interpretation');
  for (const identity of ['tenant:user-b', 'other-tenant:user-a'])
    expect(readResearchDraft(researchDraftKey(identity, params)).analysis).toBe('');
  for (const field of ['folder', 'client', 'leftRevision', 'rightRevision', 'rightSession']) {
    const changed = new URLSearchParams(params);
    changed.set(field, 'changed');
    expect(readResearchDraft(researchDraftKey('tenant:user-a', changed)).analysis).toBe('');
  }
});
test('source links reject active URLs and only add verified PDF page locators', () => {
  expect(passageSourceUrl('javascript:alert(1)', 'page:2')).toBeUndefined();
  expect(passageSourceUrl('https://user:pass@example.com/a.pdf', 'page:2')).toBeUndefined();
  expect(passageSourceUrl('https://publisher.example/a.pdf', 'page:91')).toBe(
    'https://publisher.example/a.pdf#page=91',
  );
  expect(passageSourceUrl('https://publisher.example/a.html', 'paragraph:91')).toBe(
    'https://publisher.example/a.html',
  );
});
