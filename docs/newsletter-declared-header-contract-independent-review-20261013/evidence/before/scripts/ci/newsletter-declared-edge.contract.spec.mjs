import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DECLARED_NEWSLETTER_EDGE_PINS, projectDeclaredNewsletterEdge,
  selectDeclaredNewsletterTarget, matchesDeclaredNewsletterManualPreview,
  resolveNewsletterPublicationOrigins, runtimeAcceptanceRequirements,
} from '../lib/newsletter-declared-edge-contract.mjs';

// Only the enumerated tracked source files are read. All requests are inert data.
const sources = new Map(DECLARED_NEWSLETTER_EDGE_PINS.sources.map(pin =>
  [pin.path, readFileSync(new URL(`../../${pin.path}`, import.meta.url))]));
const fixture = extra => ({ sources, appHost: 'app.capiro.ai', rootDomain: 'capiro.ai',
  wildcardHost: '*.app.capiro.ai', ...extra });
const contract = projectDeclaredNewsletterEdge(fixture());
const token = 'a'.repeat(64);
const capability = `/api/engagement/newsletter-public/${token}`;
const request = (path, extra = {}) => ({ host: 'app.capiro.ai', path, ...extra });
const select = (path, extra) => selectDeclaredNewsletterTarget(contract, request(path, extra));

test('projection verifies nine exact source bytes and exposes the declared listener with provenance', () => {
  assert.equal(DECLARED_NEWSLETTER_EDGE_PINS.commit, '523ef9167f05a33efdbdfbbfc08d5fc2e2679012');
  assert.equal(DECLARED_NEWSLETTER_EDGE_PINS.sources.length, 9);
  assert.equal(contract.provenance.sourceBytesVerified, true);
  assert.equal(contract.provenance.liveDriftWarningDeclared, true);
  assert.equal(contract.provenance.liveDriftCommentDate, '2026-06-27');
  assert.equal(contract.listenerModel, 'managed-compute-cdk-only');
  assert.deepEqual(contract.rules.map(rule => [rule.name, rule.priority, rule.target]),
    [['ApiPaths', 3, 'api'], ['Marketing', 5, 'marketing'], ['WorkspaceApi', 10, 'workspace'], ['WebDefault', 20, 'web']]);
  assert.equal(contract.rules[0].anyHost, true);
  assert.deepEqual(contract.rules[0].paths, ['/api/*', '/webhooks/*', '/health']);
  assert.ok(contract.rules.every(rule => rule.source.path === 'infra/cdk/lib/compute-stack.ts' && rule.source.line > 2300));
});

test('publication origins reproduce distinct capability and web asset precedence without reading configuration', () => {
  assert.deepEqual(resolveNewsletterPublicationOrigins(), {
    capabilityOrigin: 'https://app.capiro.ai', assetOrigin: 'https://app.capiro.ai',
    rendererPublicUrl: 'https://app.capiro.ai',
    capabilityBaseUrl: 'https://app.capiro.ai/api/engagement/newsletter-public',
    uploadBaseUrl: 'https://app.capiro.ai/workspace-api/newsletters/assets/file',
    relativeBackgroundImageBase: 'archive-document-origin', usesSourceFallback: true, realLiveVerified: false,
  });
  const split = resolveNewsletterPublicationOrigins({ apiPublicUrl: 'https://archive.example/', webPublicUrl: 'https://assets.example/' });
  assert.equal(split.capabilityBaseUrl, 'https://archive.example/api/engagement/newsletter-public');
  assert.equal(split.uploadBaseUrl, 'https://assets.example/workspace-api/newsletters/assets/file');
  assert.equal(split.rendererPublicUrl, 'https://assets.example/');
  assert.equal(split.relativeBackgroundImageBase, 'archive-document-origin');
  assert.equal(split.realLiveVerified, false);
  assert.equal(resolveNewsletterPublicationOrigins({ apiPublicUrl: '', webPublicUrl: 'https://web.example' }).capabilityOrigin,
    'https://web.example');
  assert.equal(resolveNewsletterPublicationOrigins({ apiPublicUrl: 'https://api.example' }).assetOrigin, 'https://app.capiro.ai');
  // Source removes exactly one final slash, not URL normalization.
  assert.equal(resolveNewsletterPublicationOrigins({ webPublicUrl: 'https://web.example//' }).assetOrigin, 'https://web.example/');
  for (const value of [null, 0, false, {}, [], { toString() { throw new Error('coercion'); } }])
    assert.throws(() => resolveNewsletterPublicationOrigins({ webPublicUrl: value }), /explicitly supplied/);
});

test('ordered API rule beats marketing and web hosts, including arbitrary hosts and ordinary recipient links', () => {
  for (const host of ['app.capiro.ai', 'tenant.app.capiro.ai', 'capiro.ai', 'www.capiro.ai', 'unrelated.example']) {
    for (const path of [`${capability}/archive`, `${capability}/unsubscribe`, `${capability}/preferences`,
      `${capability}/survey?block=choice&answer=One%20%26%20Two%2FThree`, '/webhooks/recall', '/health'])
      assert.equal(select(path, { host }), 'api');
  }
  assert.equal(select(`${capability}/archive`, { headers: { 'X-Capiro-Engagement-Preview': 'v3' } }), 'api');
  assert.equal(select('/api'), 'web');
  assert.equal(select('/API/engagement/newsletter-public/token/archive'), 'web');
  assert.equal(select('/healthz'), 'web');
  assert.equal(select('/health/'), 'web');
  assert.equal(select('/api-malformed/newsletter-public/token/archive'), 'web');
  assert.equal(select('/api/'), 'api');
});

test('Workspace upload route precedes the web rule and remains distinct from workspace SPA paths', () => {
  assert.equal(select(`/workspace-api/newsletters/assets/file/${token}`), 'workspace');
  assert.equal(select(`/workspace-api/newsletters/assets/file/${token}`, { host: 'outside.example' }), 'workspace');
  assert.equal(select('/workspace/newsletters/assets/file/token'), 'web');
  assert.equal(select('/workspace-api'), 'web');
  assert.equal(select('/workspace-apix/newsletters/assets/file/token'), 'web');
  // Marketing priority 5 also precedes Workspace priority 10 in this source.
  assert.equal(select(`/workspace-api/newsletters/assets/file/${token}`, { host: 'capiro.ai' }), 'marketing');
});

test('static assets follow explicit web hosts; unknown and vnext hosts do not silently join the managed listener', () => {
  assert.equal(select('/newsletter/capitol.png'), 'web');
  assert.equal(select('/newsletter/capitol.png', { host: 'tenant.app.capiro.ai' }), 'web');
  assert.equal(select('/newsletter/capitol.png', { host: 'sub.tenant.app.capiro.ai' }), 'web');
  assert.equal(select('/newsletter/capitol.png', { host: 'APP.CAPIRO.AI' }), 'web');
  assert.equal(select('/newsletter/capitol.png', { host: 'capiro.ai' }), 'marketing');
  for (const host of ['outside.example', 'os.capiro.ai', 'evilapp.capiro.ai', 'app.capiro.ai.evil.example'])
    assert.equal(select('/newsletter/capitol.png', { host }), 'unmatched');
  assert.equal(contract.unmatchedStatus, 404);
  assert.equal(contract.webVnext.pathRuleDeclared, false);
  assert.equal(contract.webVnext.fullEngagementFlagCreatesPathRule, false);
  assert.equal(contract.webVnext.actualEngagementAlbRuleRequired, true);
});

test('same app/root input suppresses the conditional marketing rule without inventing runtime hosts', () => {
  const dev = projectDeclaredNewsletterEdge(fixture({ appHost: 'app-dev.example', rootDomain: 'app-dev.example',
    wildcardHost: '*.app-dev.example' }));
  assert.equal(dev.rules.some(rule => rule.target === 'marketing'), false);
  assert.equal(selectDeclaredNewsletterTarget(dev, { host: 'app-dev.example', path: '/newsletter/capitol.png' }), 'web');
  assert.equal(selectDeclaredNewsletterTarget(dev, { host: 'app-dev.example', path: '/api/anything' }), 'api');
  assert.equal(selectDeclaredNewsletterTarget(dev, request('/newsletter/capitol.png')), 'unmatched');
});

test('other declared backend paths cannot be misreported as web by the newsletter subset', () => {
  assert.deepEqual(contract.outOfScopeRules.map(rule => [rule.priority, rule.paths[0], rule.sourceTarget]),
    [[12, '/strategy-api/*', 'apiStrategyTargetGroup'], [15, '/meri-api/*', 'meriv2OrchestratorTargetGroup']]);
  assert.equal(select('/strategy-api/action'), 'unmatched');
  assert.equal(select('/meri-api/action'), 'unmatched');
  assert.equal(select('/meri-api/action', { host: 'capiro.ai' }), 'marketing');
});

test('manual preview remains a separate exact default gate requiring both path and header', () => {
  assert.equal(contract.manualPreview.listenerModel, 'separate-manual-default-dark-preview');
  assert.equal(contract.manualPreview.priority, 6);
  assert.equal(contract.manualPreview.conditionJoin, 'AND');
  assert.equal(contract.manualPreview.deployedRuleVerified, false);
  assert.equal(contract.manualPreview.sourceDefaultsMayBeOverridden, true);
  assert.equal(contract.manualPreview.headerIsAuthorization, false);
  assert.equal(contract.manualPreview.ordinaryRecipientHeaderPresent, false);
  const matches = (path, headers = {}) => matchesDeclaredNewsletterManualPreview(contract, request(path, { headers }));
  assert.equal(matches(`${capability}/archive`), false);
  assert.equal(matches(`${capability}/archive`, { 'X-Capiro-Engagement-Preview': 'v3' }), true);
  assert.equal(matches(`${capability}/survey?block=one&answer=two`, { 'x-capiro-engagement-preview': 'v3' }), true);
  for (const value of ['', 'v2', 'v3 ', 'v3,v2'])
    assert.equal(matches(`${capability}/archive`, { 'x-capiro-engagement-preview': value }), false);
  assert.equal(matches('/api/engagement', { 'x-capiro-engagement-preview': 'v3' }), false);
  assert.equal(matches('/api/another/path', { 'x-capiro-engagement-preview': 'v3' }), false);
  // Even a modeled matching manual gate does not change the managed CDK result.
  assert.equal(select(`${capability}/archive`, { headers: { 'x-capiro-engagement-preview': 'v3' } }), 'api');
});

test('capability methods query and privacy are source-declared; edge forwarding grants no backend method', () => {
  assert.deepEqual(contract.capabilities.methods.map(row => `${row.method} ${row.path.replace(':token', 'TOKEN')}`), [
    'GET /api/engagement/newsletter-public/TOKEN/archive',
    'GET /api/engagement/newsletter-public/TOKEN/unsubscribe', 'POST /api/engagement/newsletter-public/TOKEN/unsubscribe',
    'GET /api/engagement/newsletter-public/TOKEN/preferences', 'POST /api/engagement/newsletter-public/TOKEN/preferences',
    'GET /api/engagement/newsletter-public/TOKEN/survey', 'POST /api/engagement/newsletter-public/TOKEN/survey',
  ]);
  assert.deepEqual(contract.capabilities.methods.filter(row => row.path.endsWith('/survey')).map(row => row.query),
    [['block', 'answer'], ['block', 'answer']]);
  assert.equal(contract.capabilities.headers['cache-control'], 'private, no-store');
  assert.equal(contract.capabilities.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(contract.capabilities.headers['referrer-policy'], 'no-referrer');
  assert.equal(contract.capabilities.headers['x-content-type-options'], 'nosniff');
  assert.match(contract.capabilities.headers['content-security-policy'], /form-action 'self'; frame-ancestors 'none'/);
  assert.equal(contract.capabilities.currentHeadDeclared, false);
  assert.equal(contract.capabilities.validTokenRequiresStagedPublishedDelivery, true);
  assert.equal(contract.capabilities.getDoesNotConfirmMutation, true);
  assert.equal(select(`${capability}/archive`, { method: 'HEAD' }), 'api');
  assert.equal(contract.capabilities.methods.some(row => row.method === 'HEAD'), false);
  assert.equal(contract.capabilities.methods.some(row => row.method === 'POST' && row.path.endsWith('/archive')), false);
});

test('immutable uploads retain their exact declared public headers and current GET contract', () => {
  assert.deepEqual(contract.uploads.methods, [{ method: 'GET', path: '/workspace-api/newsletters/assets/file/:token' }]);
  assert.equal(contract.uploads.tokenPattern, '^[a-f0-9]{64}$');
  assert.equal(contract.uploads.headers['content-type'], 'asset.mimeType');
  assert.equal(contract.uploads.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.equal(contract.uploads.headers['x-content-type-options'], 'nosniff');
  assert.equal(contract.uploads.headers['content-security-policy'], "default-src 'none'");
  assert.equal(contract.uploads.currentHeadDeclared, false);
});

test('nginx 8080 health and five static security headers remain declarations, separate from successor parity', () => {
  assert.equal(contract.web.port, 8080);
  assert.deepEqual(contract.web.health, { path: '/healthz', status: 200, body: 'ok\n' });
  assert.deepEqual(contract.web.staticSecurityHeaders, {
    'x-content-type-options': 'nosniff', 'x-frame-options': 'SAMEORIGIN',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'strict-transport-security': 'max-age=63072000; includeSubDomains; preload',
    'permissions-policy': 'geolocation=(), microphone=(), camera=()',
  });
  assert.equal(contract.web.spaFallback, '/index.html');
  assert.equal(contract.web.staticNewsletterCachePolicyDeclared, false);
  assert.equal(contract.publication.ordinaryImageAndLinkUsesPublicUrl, true);
  assert.equal(contract.publication.backgroundImageUsesPublicUrl, false);
  assert.equal(contract.publication.backgroundImageResolution, 'archive-document-origin');
  assert.equal(contract.publication.source.line, 539);
});

test('source publication, local equivalents and direct Next failures cannot promote live acceptance flags', () => {
  for (const object of [contract, runtimeAcceptanceRequirements]) {
    for (const field of ['realLiveVerified', 'fullyQualified', 'deployedServingVerified', 'nativeServingVerified', 'uiVerified'])
      assert.equal(object[field], false);
  }
  assert.equal(runtimeAcceptanceRequirements.backendHeadVerified, false);
  const gates = new Map(runtimeAcceptanceRequirements.gates.map(gate => [gate.id, gate]));
  assert.match(gates.get('live-edge').accepts, /managed CDK source alone cannot pass/);
  assert.match(gates.get('capability-api').accepts, /synthetic backend cannot prove/);
  assert.match(gates.get('publication-origins').accepts, /alternate archive origin/);
  assert.match(gates.get('native-serving').accepts, /direct Next 404 cannot pass or disprove/);
  assert.match(gates.get('future-head').accepts, /future compatibility/);
  assert.ok([...gates.values()].every(gate => gate.operands.length && gate.accepts));
});

test('missing extra wrong-type and altered source bytes refuse before producing a contract', () => {
  assert.throws(() => projectDeclaredNewsletterEdge(fixture({ sources: undefined })), /source Map/);
  const missing = new Map(sources); missing.delete(DECLARED_NEWSLETTER_EDGE_PINS.sources[0].path);
  assert.throws(() => projectDeclaredNewsletterEdge(fixture({ sources: missing })), /source Map/);
  const extra = new Map(sources); extra.set('untracked.ts', Buffer.from('not source'));
  assert.throws(() => projectDeclaredNewsletterEdge(fixture({ sources: extra })), /source Map/);
  const wrongType = new Map(sources); wrongType.set(DECLARED_NEWSLETTER_EDGE_PINS.sources[0].path, 'string source');
  assert.throws(() => projectDeclaredNewsletterEdge(fixture({ sources: wrongType })), /source pin mismatch/);
  const replacement = new Map(sources); replacement.delete(DECLARED_NEWSLETTER_EDGE_PINS.sources[0].path);
  replacement.set('fake/compute-stack.ts', sources.get(DECLARED_NEWSLETTER_EDGE_PINS.sources[0].path));
  assert.throws(() => projectDeclaredNewsletterEdge(fixture({ sources: replacement })), /source pin mismatch/);
});

for (const [name, path, before, after] of [
  ['API wrong path', 'infra/cdk/lib/compute-stack.ts', "'/api/*'", "'/app/*'"],
  ['API priority shadows marketing', 'infra/cdk/lib/compute-stack.ts', "addAction('ApiPaths', {\n      priority: 3", "addAction('ApiPaths', {\n      priority: 8"],
  ['Workspace routes to web', 'infra/cdk/lib/compute-stack.ts', 'forward([this.workspaceTargetGroup])', 'forward([this.webTargetGroup])'],
  ['preview header broadening', 'scripts/engagement-api-alb-rules.sh', 'headers.length === 1 &&', 'headers.length >= 0 &&'],
  ['private page cache leakage', 'apps/api/src/engagement/newsletter-outreach.controller.ts', 'private, no-store', 'public, max-age=1'],
  ['unexpected capability method', 'apps/api/src/engagement/newsletter-outreach.controller.ts', "@Get(':token/archive')", "@Post(':token/archive')"],
  ['survey drops exact answer query', 'apps/api/src/engagement/newsletter-outreach.controller.ts', 'query.block, query.answer', 'query.block, query.other'],
  ['upload immutable policy removed', 'apps/workspace/src/newsletters/newsletter.controller.ts', 'public, max-age=31536000, immutable', 'public, max-age=0'],
  ['origin precedence reversed', 'apps/api/src/engagement/newsletter-outreach.service.ts', 'process.env.API_PUBLIC_URL || process.env.WEB_PUBLIC_URL', 'process.env.WEB_PUBLIC_URL || process.env.API_PUBLIC_URL'],
  ['background resolved through publicUrl', 'packages/shared/src/newsletter-render.ts', 'newsletterCssUrl(styles.backgroundImage)', 'newsletterCssUrl(options.publicUrl + styles.backgroundImage)'],
  ['health port changed', 'apps/web/nginx/nginx.conf', 'listen 8080 default_server;', 'listen 3000 default_server;'],
]) test(`pinned source mutation refuses: ${name}`, () => {
  const text = sources.get(path).toString('utf8');
  assert.ok(text.includes(before), 'mutation must exercise its intended source operand');
  const altered = new Map(sources); altered.set(path, Buffer.from(text.replace(before, after)));
  assert.throws(() => projectDeclaredNewsletterEdge(fixture({ sources: altered })), /source pin mismatch/);
});

test('hosts must be supplied explicitly and request targets never pass through a URL normalizer', () => {
  for (const key of ['appHost', 'rootDomain', 'wildcardHost'])
    assert.throws(() => projectDeclaredNewsletterEdge(fixture({ [key]: undefined })), /explicit literal DNS host/);
  for (const host of ['', 'app.capiro.ai:443', 'app.capiro.ai.', 'https://app.capiro.ai', ' user@app.capiro.ai',
    'app.capiro.ai\n', 'app..capiro.ai', '-app.capiro.ai', 'app.capiro.ai/evil', {}, null])
    assert.throws(() => select('/newsletter/capitol.png', { host }), /literal DNS host/);
  for (const path of ['', 'https://app.capiro.ai/api/x', '//api/x', '/api/../newsletter/x', '/api/./x',
    '/api//x', '/api/%2e%2e/x', '/api/%2Fx', '/api/hello%5cx', '/api/x#fragment', '/api/x\n',
    '/api/hello\\x', '/api/%xx', '/api/\u2028', {}, null])
    assert.throws(() => select(path), /literal request path|normalization/);
  // Query encoding is opaque to routing and may contain encoded slashes.
  assert.equal(select(`${capability}/survey?block=b%2Fone&answer=a%26b%3Dc`), 'api');
});

test('uppercase configuration hosts refuse instead of changing the source raw marketing comparison', () => {
  const rawContrast = { appHost: 'APP.CAPIRO.AI', rootDomain: 'app.capiro.ai', wildcardHost: '*.app.capiro.ai' };
  assert.equal(rawContrast.rootDomain !== rawContrast.appHost, true);
  assert.throws(() => projectDeclaredNewsletterEdge(fixture(rawContrast)), /appHost configuration host must use canonical lowercase/);
  const reverseContrast = { ...rawContrast, appHost: 'app.capiro.ai', rootDomain: 'APP.CAPIRO.AI' };
  assert.equal(reverseContrast.rootDomain !== reverseContrast.appHost, true);
  assert.throws(() => projectDeclaredNewsletterEdge(fixture(reverseContrast)), /rootDomain configuration host must use canonical lowercase/);
  for (const key of ['appHost', 'rootDomain', 'wildcardHost']) {
    const original = fixture();
    assert.throws(() => projectDeclaredNewsletterEdge({ ...original, [key]: original[key].toUpperCase() }),
      new RegExp(`${key} configuration host must use canonical lowercase`));
  }
  const canonicalEqual = projectDeclaredNewsletterEdge(fixture({ appHost: 'app.capiro.ai', rootDomain: 'app.capiro.ai' }));
  assert.equal(canonicalEqual.rules.some(rule => rule.name === 'Marketing'), false);
  assert.equal(selectDeclaredNewsletterTarget(canonicalEqual, request('/newsletter/capitol.png')), 'web');
});

test('canonical configuration preserves case-insensitive request Host selection for every newsletter target', () => {
  for (const [host, path, expected] of [
    ['app.capiro.ai', '/newsletter/capitol.png', 'web'],
    ['tenant.app.capiro.ai', '/newsletter/capitol.png', 'web'],
    ['capiro.ai', '/newsletter/capitol.png', 'marketing'],
    ['www.capiro.ai', '/newsletter/capitol.png', 'marketing'],
    ['app.capiro.ai', `${capability}/archive`, 'api'],
    ['app.capiro.ai', `/workspace-api/newsletters/assets/file/${token}`, 'workspace'],
    ['outside.example', '/newsletter/capitol.png', 'unmatched'],
  ]) {
    assert.equal(select(path, { host }), expected);
    assert.equal(select(path, { host: host.toUpperCase() }), expected);
  }
});

test('special-name case-variant header duplicates refuse in ordinary and null-prototype inputs', () => {
  for (const [first, second] of [['__proto__', '__PrOtO__'], ['constructor', 'CONSTRUCTOR'],
    ['toString', 'TOSTRING'], ['hasOwnProperty', 'HASOWNPROPERTY']]) {
    const ordinary = Object.fromEntries([[first, 'first'], [second, 'second'], ['X-Capiro-Engagement-Preview', 'v3']]);
    for (const headers of [ordinary, Object.assign(Object.create(null), ordinary)]) {
      assert.ok(Object.hasOwn(headers, first) && Object.hasOwn(headers, second));
      const input = request(`${capability}/archive`, { headers });
      assert.throws(() => selectDeclaredNewsletterTarget(contract, input), /literal unambiguous headers required/);
      assert.throws(() => matchesDeclaredNewsletterManualPreview(contract, input), /literal unambiguous headers required/);
    }
  }
});

test('a single special-name header remains payload metadata without changing routing or preview authorization scope', () => {
  for (const name of ['__proto__', '__PrOtO__', 'constructor', 'toString', 'hasOwnProperty']) {
    const ordinary = Object.fromEntries([[name, 'payload metadata'], ['X-Capiro-Engagement-Preview', 'v3']]);
    for (const headers of [ordinary, Object.assign(Object.create(null), ordinary)]) {
      assert.equal(matchesDeclaredNewsletterManualPreview(contract, request(`${capability}/archive`, { headers })), true);
      assert.equal(select(`${capability}/archive`, { headers }), 'api');
      assert.equal(select('/newsletter/capitol.png', { headers }), 'web');
      assert.equal(select(`/workspace-api/newsletters/assets/file/${token}`, { headers }), 'workspace');
      assert.equal(select('/newsletter/capitol.png', { host: 'capiro.ai', headers }), 'marketing');
      const metadataOnly = Object.fromEntries([[name, 'v3']]);
      assert.equal(matchesDeclaredNewsletterManualPreview(contract, request(`${capability}/archive`, { headers: metadataOnly })), false);
    }
  }
  assert.equal(contract.manualPreview.headerIsAuthorization, false);
  assert.equal(contract.manualPreview.deployedRuleVerified, false);
  assert.equal(contract.realLiveVerified, false);
});

test('header ambiguity and forged projection objects refuse; frozen source contracts cannot be edited', () => {
  for (const headers of [[], null, { 'x-capiro-engagement-preview': ['v3'] }, { Bad: 'v3\nother' },
    { 'bad name': 'v3' }, { 'X-Capiro-Engagement-Preview': 'v3', 'x-capiro-engagement-preview': 'v2' }]) {
    if (headers === null) continue; // absent/null headers uses the documented empty default.
    assert.throws(() => select(`${capability}/archive`, { headers }), /literal.*header/);
  }
  const forged = { ...contract, rules: [{ paths: ['/api/*'], hosts: [], target: 'web', priority: 1 }] };
  assert.throws(() => selectDeclaredNewsletterTarget(forged, request(`${capability}/archive`)), /projected contract instance/);
  assert.throws(() => matchesDeclaredNewsletterManualPreview(forged, request(`${capability}/archive`)), /projected contract instance/);
  assert.throws(() => { contract.rules[0].priority = 99; }, TypeError);
  assert.throws(() => { contract.capabilities.headers['cache-control'] = 'public'; }, TypeError);
  assert.throws(() => { contract.runtimeAcceptanceRequirements.fullyQualified = true; }, TypeError);
  assert.throws(() => { DECLARED_NEWSLETTER_EDGE_PINS.sources[0].sha256 = '0'.repeat(64); }, TypeError);
  assert.equal(select(`${capability}/archive`), 'api');
});
