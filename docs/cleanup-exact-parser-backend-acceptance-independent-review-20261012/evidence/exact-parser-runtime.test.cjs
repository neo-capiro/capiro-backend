const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { BlockList, isIP } = require('node:net');
const ts = require('/workspace/capirov2/node_modules/typescript');
const parserDirectory = '/tmp/capirov2-workspace-parser-acceptance-cache-20261012/htmlparser2-8.0.2/package';
const source = '61e9b467295235829e7d8097368ce41b0434818a';
const packet = 'docs/cleanup-exact-parser-backend-acceptance-independent-review-20261012/evidence/';
const parser = require(parserDirectory);
const parserRequire = createRequire(path.join(parserDirectory, 'package.json'));
const sanitizerDirectory = '/workspace/capirov2/node_modules/.pnpm/sanitize-html@2.17.7/node_modules/sanitize-html';
const sanitizeHtml = require(sanitizerDirectory);
const { BadRequestException } = require('/tmp/capirov2-cleanup-meri-reviewed-runtime-conversion/apps/workspace/node_modules/@nestjs/common');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => cp.execFileSync('git', ['show', source + ':' + file], { encoding: 'utf8' });
const compile = value => ts.transpileModule(value, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const manifest = JSON.parse(fs.readFileSync(path.join(parserDirectory, 'package.json'), 'utf8'));
assert.equal(manifest.version, '8.0.2');
assert.equal(JSON.parse(fs.readFileSync(path.join(sanitizerDirectory, 'package.json'), 'utf8')).version, '2.17.7');
const metadataFile = 'apps/workspace/src/newsletters/newsletter-link-preview.service.ts';
const transportFile = 'apps/workspace/src/newsletters/newsletter-asset-import.service.ts';
const metadataSource = read(metadataFile), transportSource = read(transportFile);
assert.equal(metadataSource, fs.readFileSync(metadataFile, 'utf8'));
assert.equal(transportSource, fs.readFileSync(transportFile, 'utf8'));
const sf = ts.createSourceFile(metadataFile, metadataSource, ts.ScriptTarget.Latest, true);
const leafSource = sf.statements.filter(node => ts.isFunctionDeclaration(node) && ['plain', 'newsletterLinkMetadata'].includes(node.name.text)).map(node => node.getText(sf)).join('\n');
assert(leafSource.includes('onopentag(name, attrs)'));
const policySf = ts.createSourceFile(transportFile, transportSource, ts.ScriptTarget.Latest, true);
const stop = policySf.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === 'newsletterImageMime').pos;
const policySource = policySf.statements.filter(node => node.pos < stop && !ts.isImportDeclaration(node)).map(node => node.getText(policySf)).join('\n');
assert.equal(policySource.includes('request('), false);
assert.equal(policySource.includes('lookup('), false);
const urlPolicy = new Function('BlockList', 'isIP', 'BadRequestException', 'exports', compile(policySource) + '\nreturn newsletterImportUrl;')(BlockList, isIP, BadRequestException, {});
const owner = Parser => new Function('Parser', 'sanitizeHtml', 'newsletterImportUrl', 'exports', compile(leafSource) + '\nreturn {plain, newsletterLinkMetadata};')(Parser, sanitizeHtml, urlPolicy, {});
const metadata = owner(parser.Parser);
const rows = [];
function record(name, actual, expected) { assert.deepEqual(actual, expected); rows.push({ name, passed: true }); }

test('actual exact8 package CJS Parser and five cached transitive runtime bindings match locked versions', () => {
  record('CJS runtime entry', parserRequire.resolve('./'), path.join(parserDirectory, 'lib/index.js'));
  for (const [name, version] of Object.entries({ domelementtype: '2.3.0', domhandler: '5.0.3', domutils: '3.2.2', entities: '4.5.0' })) {
    let dir = path.dirname(parserRequire.resolve(name));
    while (!fs.existsSync(path.join(dir, 'package.json'))) dir = path.dirname(dir);
    const data = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    record(`runtime ${name}`, data.version, version);
  }
  const utilsRequire = createRequire(parserRequire.resolve('domutils'));
  let serializerDir = path.dirname(utilsRequire.resolve('dom-serializer'));
  while (!fs.existsSync(path.join(serializerDir, 'package.json'))) serializerDir = path.dirname(serializerDir);
  record('cached dom-serializer', JSON.parse(fs.readFileSync(path.join(serializerDir, 'package.json'), 'utf8')).version, '2.0.0');
});
test('actual Parser decodes chunked HTML and preserves ordered lower-case callback/attribute behavior', () => {
  const trace = [];
  const instance = new parser.Parser({
    onopentag: (name, attributes) => trace.push(['open', name, attributes]),
    ontext: text => trace.push(['text', text]),
    onclosetag: name => trace.push(['close', name]),
  }, { decodeEntities: true });
  instance.write('<TITLE data-X="a&amp;b">A &am');
  instance.end('p; B &#x1F680;</TITLE>');
  record('open lower-case and decoded attr', trace[0], ['open', 'title', { 'data-x': 'a&b' }]);
  record('chunked decoded text', trace.filter(row => row[0] === 'text').map(row => row[1]).join(''), 'A & B 🚀');
  record('close callback', trace.at(-1), ['close', 'title']);
});
test('actual Parser explicit XML options retain case and CDATA without a surrogate parser', () => {
  const trace = [];
  new parser.Parser({ onopentag: (name, attributes) => trace.push([name, attributes]), ontext: text => trace.push(text) }, { xmlMode: true, decodeEntities: true }).end('<Thing NAME="A&amp;B"><![CDATA[x<y]]></Thing>');
  record('XML real parser', trace, [['Thing', { NAME: 'A&B' }], 'x<y']);
});
test('original metadata leaves with real Parser: precedence, first-entry preservation, encoded markup and final-URL images', () => {
  record('OpenGraph first entry and decode', metadata.newsletterLinkMetadata('<head><title>Fallback</title><meta property="og:title" content="Policy &amp; funding"><meta property="og:title" content="Later"><meta name="twitter:title" content="Twitter"><meta property="og:description" content="&lt;strong&gt;Committee&lt;/strong&gt; &amp; update"><meta property="og:image:secure_url" content="../cover.png"></head>', 'https://news.example/policy/article'), { sourceUrl: 'https://news.example/policy/article', title: 'Policy & funding', description: 'Committee & update', imageUrl: 'https://news.example/cover.png' });
  record('Twitter metadata fallback', metadata.newsletterLinkMetadata('<head><meta name="twitter:title" content="Twitter"><meta name="twitter:description" content="Brief"><meta name="twitter:image:src" content="/twitter.png"></head>', 'https://news.example/a#ignored'), { sourceUrl: 'https://news.example/a', title: 'Twitter', description: 'Brief', imageUrl: 'https://news.example/twitter.png' });
  record('blank OG falls through to actual title', metadata.newsletterLinkMetadata('<head><meta property="og:title" content="  "><title>Real &#169; title</title></head>', 'https://news.example/a').title, 'Real © title');
});
test('real Parser metadata leaves ignore post-head/body metadata, base, scripts and rich markup', () => {
  record('body/script/base exclusion', metadata.newsletterLinkMetadata('<head><title>Safe</title><base href="https://other.example/"><script>document.title="Injected"</script><meta property="og:image" content="/safe.png"></head><body><meta property="og:title" content="Injected body"><title>Late</title></body>', 'https://news.example/a'), { sourceUrl: 'https://news.example/a', title: 'Safe', description: '', imageUrl: 'https://news.example/safe.png' });
  record('text sanitation removes embedded script contents', metadata.plain('<b>Keep</b><script>private bad</script><img src=x> &#x26; text', 2000), 'Keep & text');
  record('control whitespace collapsed', metadata.plain(' A\0\n\tB\x7f C ', 2000), 'A B C');
});
test('real Parser original bounds and host fallback remain deterministic', () => {
  const data = metadata.newsletterLinkMetadata('<head><meta property="og:title" content="' + 'A'.repeat(3000) + '"><meta name="description" content="' + 'B'.repeat(7000) + '"></head>', 'https://news.example');
  record('title limit', data.title.length, 2000);
  record('description limit', data.description.length, 6000);
  record('no metadata hostname', metadata.newsletterLinkMetadata('<html></html>', 'https://news.example').title, 'news.example');
  record('plain input limit', metadata.plain('a'.repeat(40_000), 100_000).length, 32_000);
});
test('real Parser preserves text while current URL policy refuses unsafe images and source URLs without transport', () => {
  for (const image of ['https://127.0.0.1/x.png', 'http://news.example/x.png', 'data:image/png;base64,AA', 'https://name:secret@news.example/x.png', '//local.internal/x.png', 'https://[::1]/x.png']) {
    record(`unsafe image ${image}`, metadata.newsletterLinkMetadata('<head><title>Still available</title><meta property="og:image" content="' + image + '"></head>', 'https://news.example').imageUrl, '');
  }
  for (const sourceUrl of ['http://news.example', 'https://127.0.0.1/a', 'https://local.internal/a', 'https://name:secret@news.example/a']) {
    assert.throws(() => metadata.newsletterLinkMetadata('<head><title>Title</title></head>', sourceUrl), BadRequestException);
    rows.push({ name: `unsafe source ${sourceUrl}`, passed: true });
  }
});
test('actual ESM Parser entry matches exact8 CJS metadata behavior on the same synthetic owners', async () => {
  const esm = await import(pathToFileURL(path.join(parserDirectory, 'lib/esm/index.js')).href);
  const esmOwner = owner(esm.Parser);
  for (const html of ['<head><title>Policy &amp; action</title></head>', '<head><meta property="og:title" content="&lt;b&gt;Title&lt;/b&gt;"><meta name="description" content="Short"></head>', '<html></html>']) {
    record('CJS/ESM leaf equality ' + html, esmOwner.newsletterLinkMetadata(html, 'https://news.example/a'), metadata.newsletterLinkMetadata(html, 'https://news.example/a'));
  }
});
test.after(() => {
  fs.writeFileSync(packet + 'exact-parser-runtime.json', JSON.stringify({ source, parserVersion: manifest.version, parserDirectory, actualParserCjsEsmNotMocked: true, sanitizerVersion: '2.17.7', metadataOwnerSha256: hash(metadataSource), transportPolicyOwnerSha256: hash(transportSource), selectedMetadataFunctionsSha256: hash(leafSource), selectedUrlPolicySha256: hash(policySource), checks: rows.length, results: rows, applicationServiceGraphImported: false, realDownloadProviderDatabaseNativeEngineCalls: 0, scope: 'Actual locked8 CJS/ESM parser and existing source-selected pure leaves; URL policy computed in memory, no transport or service constructor' }, null, 2) + '\n');
});
