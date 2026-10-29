import assert from 'node:assert/strict';
import test from 'node:test';
import writes from '../lib/preview/first-chat-preview-writes.json';

/**
 * The dedicated first-chat edge admits a finite set of existing owner paths. The public
 * newsletter capability forms are the only POSTs a recipient's browser issues, so they must
 * be named exactly; everything else stays behind the edge default 404.
 */
const PUBLIC_NEWSLETTER_POSTS = [
  '^/api/engagement/newsletter-public/[A-Za-z0-9_-]+/unsubscribe$',
  '^/api/engagement/newsletter-public/[A-Za-z0-9_-]+/preferences$',
  '^/api/engagement/newsletter-public/[A-Za-z0-9_-]+/survey$',
];
const token = 'a'.repeat(64);

test('the public newsletter capability POSTs are admitted by exactly one core rule group', () => {
  const groups = writes.groups.filter((group: { pathRegexes: string[] }) =>
    group.pathRegexes.some((pattern) => pattern.includes('newsletter-public')),
  );
  assert.equal(groups.length, 1);
  const [group] = groups;
  assert.equal(group.service, 'core');
  assert.equal(group.method, 'POST');
  assert.deepEqual([...group.pathRegexes].sort(), [...PUBLIC_NEWSLETTER_POSTS].sort());
});

test('each capability path matches only its own POST path', () => {
  const [group] = writes.groups.filter((g: { pathRegexes: string[] }) =>
    g.pathRegexes.some((pattern) => pattern.includes('newsletter-public')),
  );
  const patterns = group.pathRegexes.map((pattern) => new RegExp(pattern));
  for (const [index, action] of ['unsubscribe', 'preferences', 'survey'].entries()) {
    const permitted = `/api/engagement/newsletter-public/${token}/${action}`;
    assert.equal(patterns[index].test(permitted), true, permitted);
    for (const other of ['unsubscribe', 'preferences', 'survey'].filter((a) => a !== action))
      assert.equal(patterns[index].test(`/api/engagement/newsletter-public/${token}/${other}`), false, other);
    // Reads, trailing suffixes and other capability actions stay outside the admitted set.
    for (const rejected of [
      `/api/engagement/newsletter-public/${token}/archive`,
      `/api/engagement/newsletter-public/${token}/${action}/extra`,
      `/api/engagement/newsletter-public/${token}/${action}?x=1`,
      `/api/engagement/newsletter-public/${action}`,
      `/api/engagement/newsletter-public/${token}/other`,
    ])
      assert.equal(patterns[index].test(rejected), false, rejected);
  }
});

test('no group becomes a wildcard and every group keeps the five-value rule budget', () => {
  for (const group of writes.groups) {
    assert.ok(group.pathRegexes.length > 0 && group.pathRegexes.length <= 3, group.service);
    // host condition + method condition + up to three path values stays within five.
    assert.ok(group.pathRegexes.length + 2 <= 5);
    for (const pattern of group.pathRegexes) {
      assert.ok(pattern.startsWith('^') && pattern.endsWith('$'), pattern);
      assert.ok(pattern.length <= 128, pattern);
      assert.doesNotMatch(pattern, /\(\?s\)|\/\*$|\^\/api\/\*/, pattern);
    }
  }
  // The generic GET/HEAD read rule is the only broad admission, and it is method-scoped.
  assert.doesNotMatch(writes.note, /wildcard/i);
});

test('onboarding admissions are appended after the accepted newsletter group', () => {
  const groups = writes.groups as { id?: string; service: string; method: string; pathRegexes: string[] }[];
  const ids = groups.map((group) => group.id);
  assert.equal(groups.length, 87);
  assert.equal(ids[82], 'PublicNewsletterCapabilityPosts');
  assert.deepEqual(ids.slice(83), [
    'OnboardPublicReads',
    'OnboardSetupPosts',
    'OnboardInvitePosts',
    'CoreInternalOnboardingTenants',
  ]);
  const byId = new Map(groups.map((group) => [group.id, group]));
  const expectGroup = (id: string, service: string, method: string, paths: string[]) => {
    const group = byId.get(id)!;
    assert.equal(group.service, service, id);
    assert.equal(group.method, method, id);
    assert.deepEqual(group.pathRegexes, paths, id);
  };
  expectGroup('OnboardPublicReads', 'onboard', 'GET', [
    '^/onboard-api/public/config$',
    '^/onboard-api/setup/state$',
    '^/onboard-api/it/invite/[A-Za-z0-9_-]+$',
  ]);
  expectGroup('OnboardSetupPosts', 'onboard', 'POST', [
    '^/onboard-api/setup/tasks/[A-Za-z0-9_-]+/transition$',
    '^/onboard-api/setup/complete$',
    '^/onboard-api/setup/it-invites$',
  ]);
  expectGroup('OnboardInvitePosts', 'onboard', 'POST', [
    '^/onboard-api/setup/it-invites/[A-Za-z0-9_-]+/resend$',
    '^/onboard-api/it/invite/[A-Za-z0-9_-]+/consent-url$',
    '^/onboard-api/it/invite/[A-Za-z0-9_-]+/skip-google$',
  ]);
  expectGroup('CoreInternalOnboardingTenants', 'core', 'POST', [
    '^/api/internal/onboarding/tenants$',
  ]);
  // No blanket write routing, no lifecycle hard-delete admission, bounded anchored tokens.
  for (const group of groups)
    for (const pattern of group.pathRegexes) {
      assert.ok(pattern.startsWith('^') && pattern.endsWith('$'), pattern);
      assert.ok(!/hard-delete/.test(pattern), pattern);
      assert.ok(!/\*/.test(pattern), pattern);
    }
});
