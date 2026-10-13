import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalNewsletterManifest, HISTORICAL_NEWSLETTER_ORIGIN, NEWSLETTER_PINS,
  NEWSLETTER_UPLOAD_HEADERS, NEWSLETTER_CAPABILITY_HEADERS, newsletterByteIdentity,
  validateNewsletterManifest, qualifyNewsletterArtifact, qualifyNewsletterResponse,
  parseNewsletterContractInvocation } from '../lib/newsletter-static-release-contract.mjs';

// Default source CI is entirely in-memory: no Web, filesystem, environment,
// provider, build or server reads. Real legacy-byte parity is opt-in below.
const mode = parseNewsletterContractInvocation(process.argv.slice(2));
const manifest = canonicalNewsletterManifest();
const byUrl = new Map(manifest.map((entry) => [entry.publicPath, entry]));
const artifactSource = { repository: NEWSLETTER_PINS.frontendRepository, commit: NEWSLETTER_PINS.frontendCode };
const syntheticMap = () => new Map(manifest.map((entry) => [entry.publicPath, Buffer.from(entry.publicPath)]));
function fakeIdentity(bytes, path) {
  return bytes.equals(Buffer.from(path)) ? byUrl.get(path) : newsletterByteIdentity(bytes);
}
const artifact = (extra = {}) => ({ manifest, assets: syntheticMap(), artifactSource, identity: fakeIdentity, ...extra });
const token = 'a'.repeat(64);
const staticUrl = HISTORICAL_NEWSLETTER_ORIGIN + '/newsletter/capitol.png';
const uploadUrl = `${HISTORICAL_NEWSLETTER_ORIGIN}/workspace-api/newsletters/assets/file/${token}`;
const capabilityUrl = `${HISTORICAL_NEWSLETTER_ORIGIN}/api/engagement/newsletter-public/${token}/archive`;
function staticResponse(extra = {}) {
  return { kind: 'static', url: staticUrl, method: 'GET', status: 200,
    headers: { 'Content-Type': 'image/png', 'X-Content-Type-Options': 'nosniff' },
    body: Buffer.from('/newsletter/capitol.png'), identity: fakeIdentity, ...extra };
}
function uploadResponse(extra = {}) {
  const body = Buffer.from('synthetic uploaded image; not a stored user asset');
  return { kind: 'upload', url: uploadUrl, method: 'GET', status: 200, body,
    expectedBody: newsletterByteIdentity(body), expectedMime: 'image/png',
    headers: { ...NEWSLETTER_UPLOAD_HEADERS, 'content-type': 'image/png' }, ...extra };
}
function capabilityResponse(extra = {}) {
  return { kind: 'capability', url: capabilityUrl, method: 'GET', status: 200,
    headers: { ...NEWSLETTER_CAPABILITY_HEADERS }, body: Buffer.from('<!doctype html><html>synthetic public page</html>'), ...extra };
}

if (mode === 'source') {
  test('fixed manifest and source pins preserve all 179 identities and 172 rendered PNGs', () => {
    const receipt = validateNewsletterManifest(manifest);
    assert.equal(receipt.bytes, 486014);
    assert.equal(manifest.filter((entry) => entry.publicPath.endsWith('.png')).length, 172);
    assert.equal(manifest.filter((entry) => entry.publicPath.endsWith('.svg')).length, 5);
    assert.equal(manifest.filter((entry) => entry.publicPath.endsWith('.txt')).length, 2);
    const platforms = 'bluesky discord email facebook forward instagram instapaper linkedin patreon pinterest reddit snapchat spotify telegram threads tiktok twitch twitter website whatsapp youtube'.split(' ');
    const styles = 'color dark light gray color-white dark-white light-black gray-black'.split(' ');
    for (const platform of platforms) for (const style of styles)
      assert.ok(byUrl.has(`/newsletter/social-${platform}-${style}.png`));
    for (const name of ['capitol', 'newsroom', 'policy-desk', 'social-update'])
      for (const extension of ['png', 'svg']) assert.ok(byUrl.has(`/newsletter/${name}.${extension}`));
    assert.equal(NEWSLETTER_PINS.frontendManifestBlob, 'de1385b1f078f4307b381d0e6c925c15d6653eee');
    assert.equal(NEWSLETTER_PINS.entriesTsvSha256, '8619b8b41de3d6e2001682a781260d1c90199dfd6dc3ac7e5a99b457fe27fa01');
    assert.equal(receipt.actualArtifactBytesVerified, false);
    assert.equal(receipt.deployedServingVerified, false);
  });
  for (const [name, mutate, message] of [
    ['missing', (rows) => rows.pop(), /missing/],
    ['duplicate', (rows) => rows.push({ ...rows[0] }), /duplicate/],
    ['unlisted', (rows) => { rows[0].publicPath = '/newsletter/unlisted.png'; }, /unlisted/],
    ['wrong source path', (rows) => { rows[0].path = 'apps/web/public/../secret'; }, /noncanonical/],
    ['length', (rows) => { rows[0].bytes++; }, /identity/],
    ['digest', (rows) => { rows[0].sha256 = '0'.repeat(64); }, /identity/],
    ['Git blob', (rows) => { rows[0].gitBlob = '0'.repeat(40); }, /identity/],
    ['extra field', (rows) => { rows[0].unknown = true; }, /malformed/],
  ]) test(`manifest refuses ${name}`, () => {
    const rows = canonicalNewsletterManifest(); mutate(rows);
    assert.throws(() => validateNewsletterManifest(rows), message);
  });
  test('caller mutation cannot alter the canonical oracle; manifest order is immaterial', () => {
    const rows = canonicalNewsletterManifest(); rows[0].bytes = 1;
    assert.notEqual(canonicalNewsletterManifest()[0].bytes, 1);
    assert.equal(validateNewsletterManifest([...manifest].reverse()).staticPaths, 179);
  });
  test('synthetic equal artifact is source-only and cannot attest actual bytes or serving', async () => {
    const receipt = await qualifyNewsletterArtifact(artifact());
    assert.equal(receipt.sourceOnly, true);
    assert.equal(receipt.exactArtifactMembershipVerified, true);
    assert.equal(receipt.actualArtifactBytesVerified, false);
    assert.equal(receipt.deployedServingVerified, false);
    assert.deepEqual(receipt.artifactSource, artifactSource);
  });
  for (const [name, mutate, message] of [
    ['corrupt bytes', (map) => map.set('/newsletter/capitol.png', Buffer.from('corrupt')), /byte identity/],
    ['missing bytes', (map) => map.delete('/newsletter/capitol.png'), /missing/],
    ['extra bytes', (map) => map.set('/newsletter/unlisted.png', Buffer.from('extra')), /unlisted/],
    ['HTML fallback', (map) => map.set('/newsletter/capitol.png', Buffer.from('<html>login</html>')), /byte identity/],
  ]) test(`artifact refuses ${name}`, async () => {
    const assets = syntheticMap(); mutate(assets);
    await assert.rejects(qualifyNewsletterArtifact(artifact({ assets })), message);
  });
  test('injected reader enumerates only canonical URLs and cannot claim exact external membership', async () => {
    const calls = [];
    const receipt = await qualifyNewsletterArtifact(artifact({ assets: undefined,
      readAsset: (path) => { calls.push(path); return Buffer.from(path); } }));
    assert.deepEqual(calls, manifest.map((entry) => entry.publicPath));
    assert.equal(receipt.exactArtifactMembershipVerified, false);
    assert.equal(receipt.actualArtifactBytesVerified, false);
    await assert.rejects(qualifyNewsletterArtifact(artifact({ assets: undefined, readAsset: () => undefined })), /byte identity/);
  });
  test('real hashing remains mandatory without synthetic port; absent or ambiguous provenance refuses', async () => {
    await assert.rejects(qualifyNewsletterArtifact(artifact({ identity: newsletterByteIdentity })), /byte identity/);
    await assert.rejects(qualifyNewsletterArtifact(artifact({ artifactSource: undefined })), /source pin/);
    await assert.rejects(qualifyNewsletterArtifact(artifact({ readAsset: () => Buffer.alloc(0) })), /one artifact input/);
  });
  test('static GET/HEAD preserve exact URL/type/bytes without inventing an immutable cache requirement', () => {
    for (const entry of manifest) {
      const mime = entry.publicPath.endsWith('.png') ? 'image/png' : entry.publicPath.endsWith('.svg') ? 'image/svg+xml' : 'text/plain';
      const receipt = qualifyNewsletterResponse(staticResponse({ url: HISTORICAL_NEWSLETTER_ORIGIN + entry.publicPath,
        body: Buffer.from(entry.publicPath), headers: { 'content-type': mime, 'x-content-type-options': 'nosniff' } }));
      assert.equal(receipt.historicalOriginContract, true);
      assert.equal(receipt.actualArtifactBytesVerified, false);
      assert.equal(receipt.deployedServingVerified, false);
    }
    qualifyNewsletterResponse(staticResponse({ method: 'HEAD', body: Buffer.alloc(0),
      headers: { 'content-type': 'image/png', 'x-content-type-options': 'nosniff', 'content-length': String(byUrl.get('/newsletter/capitol.png').bytes) } }));
  });
  for (const [name, changes, message] of [
    ['new current preview origin', { url: staticUrl.replace('app.capiro.ai', 'new.example') }, /origin/],
    ['encoded path', { url: staticUrl.replace('capitol', '%63apitol') }, /path/],
    ['normalized dot path', { url: staticUrl.replace('/newsletter/', '/other/../newsletter/') }, /path/],
    ['trimmed control', { url: '\n' + staticUrl }, /path/],
    ['unknown path', { url: HISTORICAL_NEWSLETTER_ORIGIN + '/newsletter/new.png' }, /unknown/],
    ['HTML MIME fallback', { headers: { 'content-type': 'text/html', 'x-content-type-options': 'nosniff' } }, /content-type/],
    ['wrong bytes', { body: Buffer.from('other') }, /byte identity/],
    ['missing nosniff', { headers: { 'content-type': 'image/png' } }, /header/],
    ['redirect', { status: 302 }, /successful/],
    ['200 login redirect', { headers: { 'content-type': 'image/png', 'x-content-type-options': 'nosniff', location: '/login' } }, /redirect/],
    ['POST asset', { method: 'POST' }, /method/],
    ['HEAD body', { method: 'HEAD' }, /HEAD/],
    ['HEAD wrong length', { method: 'HEAD', body: Buffer.alloc(0), headers: { 'content-type': 'image/png', 'x-content-type-options': 'nosniff', 'content-length': '1' } }, /length/],
  ]) test(`static response refuses ${name}`, () => assert.throws(() => qualifyNewsletterResponse(staticResponse(changes)), message));
  test('dynamic uploads retain raw image/font MIME and exact public controller headers', () => {
    for (const expectedMime of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'font/ttf', 'font/otf', 'font/woff', 'font/woff2']) {
      const receipt = qualifyNewsletterResponse(uploadResponse({ expectedMime,
        headers: { ...NEWSLETTER_UPLOAD_HEADERS, 'content-type': expectedMime } }));
      assert.equal(receipt.dynamicStorageOrCapabilityVerified, false);
      assert.equal(receipt.deployedServingVerified, false);
    }
  });
  for (const [name, changes] of [
    ['token', { url: uploadUrl.replace(token, 'invalid') }],
    ['authoring route', { url: HISTORICAL_NEWSLETTER_ORIGIN + '/workspace-api/newsletters/assets' }],
    ['unknown MIME', { expectedMime: 'text/html' }], ['changed stored bytes', { body: Buffer.from('corrupt') }],
    ['POST', { method: 'POST' }], ['missing expected identity', { expectedBody: undefined }],
  ]) test(`upload refuses ${name}`, () => assert.throws(() => qualifyNewsletterResponse(uploadResponse(changes))));
  for (const name of Object.keys(NEWSLETTER_UPLOAD_HEADERS)) test(`upload preserves ${name}`, () => {
    const response = uploadResponse(); response.headers[name] = 'changed';
    assert.throws(() => qualifyNewsletterResponse(response), /header/);
  });
  test('optional CORS assertion retains exact admitted origin and credentials', () => {
    const response = uploadResponse({ corsOrigin: HISTORICAL_NEWSLETTER_ORIGIN,
      headers: { ...NEWSLETTER_UPLOAD_HEADERS, 'content-type': 'image/png',
        'access-control-allow-origin': HISTORICAL_NEWSLETTER_ORIGIN, 'access-control-allow-credentials': 'true' } });
    assert.equal(qualifyNewsletterResponse(response).corsContractVerified, true);
    assert.equal(qualifyNewsletterResponse(uploadResponse()).corsContractVerified, false);
    assert.throws(() => qualifyNewsletterResponse({ ...response, headers: { ...response.headers, 'access-control-allow-origin': '*' } }), /CORS/);
    assert.throws(() => qualifyNewsletterResponse({ ...response, headers: { ...response.headers, 'access-control-allow-credentials': 'false' } }), /CORS/);
    assert.throws(() => qualifyNewsletterResponse({ ...response, corsOrigin: 'https://unqualified.example',
      headers: { ...response.headers, 'access-control-allow-origin': 'https://unqualified.example' } }), /CORS/);
  });
  test('public capabilities preserve GET/forms/query strings and keep archive GET-only', () => {
    for (const route of ['archive', 'unsubscribe', 'preferences', 'survey']) {
      const url = capabilityUrl.replace('/archive', '/' + route) + '?block=public&answer=public';
      qualifyNewsletterResponse(capabilityResponse({ url }));
      if (route !== 'archive') qualifyNewsletterResponse(capabilityResponse({ url, method: 'POST' }));
    }
    assert.throws(() => qualifyNewsletterResponse(capabilityResponse({ method: 'POST' })), /method/);
    assert.throws(() => qualifyNewsletterResponse(capabilityResponse({ url: capabilityUrl.replace('/newsletter-public/', '/newsletters/') })), /route/);
  });
  for (const name of Object.keys(NEWSLETTER_CAPABILITY_HEADERS)) test(`capability preserves ${name}`, () => {
    const response = capabilityResponse(); response.headers[name] = 'changed';
    assert.throws(() => qualifyNewsletterResponse(response), /header/);
  });
  test('duplicate case-insensitive headers refuse; no current-origin preview is an old-origin receipt', () => {
    const response = staticResponse(); response.headers['content-type'] = 'image/png';
    assert.throws(() => qualifyNewsletterResponse(response), /ambiguous/);
    const current = qualifyNewsletterResponse(staticResponse({ url: staticUrl.replace('app.capiro.ai', 'new.example'), expectedOrigin: 'https://new.example' }));
    assert.equal(current.historicalOriginContract, false);
    assert.equal(current.deployedServingVerified, false);
  });
  test('mode parser refuses ambiguity before optional filesystem imports', () => {
    assert.equal(parseNewsletterContractInvocation([]), 'source');
    assert.equal(parseNewsletterContractInvocation(['--frontend-parity']), 'frontend-parity');
    for (const args of [['--FRONTEND-PARITY'], [' --frontend-parity '], ['--frontend-parity', 'extra'], ['--frontend-parity=true']])
      assert.throws(() => parseNewsletterContractInvocation(args));
  });
  test('literal expected origins reject normalization and coercion before identity effects', () => {
    let identities = 0, coercions = 0;
    const coercible = { toString() { coercions++; return HISTORICAL_NEWSLETTER_ORIGIN; } };
    const invalid = ['\n' + HISTORICAL_NEWSLETTER_ORIGIN, HISTORICAL_NEWSLETTER_ORIGIN + '\n',
      HISTORICAL_NEWSLETTER_ORIGIN + '\u2028', HISTORICAL_NEWSLETTER_ORIGIN + ' ',
      'https://app.\tcapiro.ai', HISTORICAL_NEWSLETTER_ORIGIN + '/other/..',
      HISTORICAL_NEWSLETTER_ORIGIN + '/./', HISTORICAL_NEWSLETTER_ORIGIN + ':443',
      'HTTPS://APP.CAPIRO.AI', new URL(HISTORICAL_NEWSLETTER_ORIGIN), coercible, null, 7];
    for (const expectedOrigin of invalid) assert.throws(() => qualifyNewsletterResponse(staticResponse({
      expectedOrigin, identity: () => { identities++; return byUrl.get('/newsletter/capitol.png'); } })), /origin/);
    assert.equal(identities, 0); assert.equal(coercions, 0);
    qualifyNewsletterResponse(staticResponse({ expectedOrigin: HISTORICAL_NEWSLETTER_ORIGIN + '/' }));
  });
  test('literal CORS origins reject normalization and coercion before identity effects', () => {
    let identities = 0, coercions = 0;
    const response = uploadResponse({ headers: { ...NEWSLETTER_UPLOAD_HEADERS, 'content-type': 'image/png',
      'access-control-allow-origin': HISTORICAL_NEWSLETTER_ORIGIN, 'access-control-allow-credentials': 'true' } });
    for (const corsOrigin of [HISTORICAL_NEWSLETTER_ORIGIN + '\n', '\t' + HISTORICAL_NEWSLETTER_ORIGIN,
      HISTORICAL_NEWSLETTER_ORIGIN + '/other/..', HISTORICAL_NEWSLETTER_ORIGIN + '/./',
      new URL(HISTORICAL_NEWSLETTER_ORIGIN), { toString() { coercions++; return HISTORICAL_NEWSLETTER_ORIGIN; } }])
      assert.throws(() => qualifyNewsletterResponse({ ...response, corsOrigin,
        identity: () => { identities++; return response.expectedBody; } }), /origin/);
    assert.equal(identities, 0); assert.equal(coercions, 0);
    assert.throws(() => qualifyNewsletterResponse({ ...response, corsOrigin: HISTORICAL_NEWSLETTER_ORIGIN + '/' }), /CORS/);
  });
  test('unpadded literal repository and commit pins refuse controls before artifact read effects', async () => {
    let reads = 0, coercions = 0;
    const coercible = { toString() { coercions++; return artifactSource.commit; } };
    for (const source of [
      { ...artifactSource, commit: artifactSource.commit + '\n' },
      { ...artifactSource, commit: artifactSource.commit + '\u2028' },
      { ...artifactSource, commit: ' ' + artifactSource.commit },
      { ...artifactSource, commit: coercible }, { ...artifactSource, commit: 7 },
      { ...artifactSource, repository: artifactSource.repository + '\n' },
      { ...artifactSource, repository: artifactSource.repository + '\u2028' },
      { ...artifactSource, repository: '\t' + artifactSource.repository },
      { ...artifactSource, repository: 'neo-capiro/ca\u0000piro-frontend' },
      { ...artifactSource, repository: { toString() { coercions++; return artifactSource.repository; } } },
    ]) await assert.rejects(qualifyNewsletterArtifact(artifact({ assets: undefined, artifactSource: source,
      readAsset: () => { reads++; throw new Error('unexpected artifact read'); } })), /source pin/);
    assert.equal(reads, 0); assert.equal(coercions, 0);
  });
} else {
  // Deliberately absent from backend CI. No server request or build is performed.
  test('explicit frontend parity verifies all original legacy bytes and source header contracts', async () => {
    const fs = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const directory = root + 'apps/web/public/newsletter';
    const listing = await fs.readdir(directory, { withFileTypes: true });
    assert.ok(listing.every((entry) => entry.isFile() && !entry.isSymbolicLink()));
    assert.deepEqual(listing.map((entry) => '/newsletter/' + entry.name).sort(), [...byUrl.keys()].sort());
    const assets = new Map();
    for (const entry of manifest) assets.set(entry.publicPath, await fs.readFile(root + entry.path));
    const receipt = await qualifyNewsletterArtifact({ manifest, assets,
      artifactSource: { repository: NEWSLETTER_PINS.sourceRepository, commit: NEWSLETTER_PINS.sourceCommit } });
    assert.equal(receipt.actualArtifactBytesVerified, true);
    assert.equal(receipt.deployedServingVerified, false);
    const publicSource = await fs.readFile(root + 'apps/api/src/engagement/newsletter-outreach.controller.ts', 'utf8');
    for (const value of Object.values(NEWSLETTER_CAPABILITY_HEADERS)) assert.ok(publicSource.includes(value));
    const uploads = await fs.readFile(root + 'apps/workspace/src/newsletters/newsletter.controller.ts', 'utf8');
    for (const value of Object.values(NEWSLETTER_UPLOAD_HEADERS)) assert.ok(uploads.includes(value));
    console.log(JSON.stringify({ qualification: 'frontend-legacy-byte-parity', ...receipt }));
  });
}
