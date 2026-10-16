import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Current isolated domain and retained-facade source contracts.
// Only the isolated real domain/input/bill-text modules and FIVE actual current
// forwarding methods are loaded. The decorated Meri/Engagement classes are data.
// Nest exception shape and shared ID/status functions below are explicit fixture
// bindings. These controls do not qualify Nest, shared normalization, Prisma/SQL
// execution, DB behavior, application typing or native application acceptance.
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../..');
const read = relative => readFileSync(path.join(ROOT, relative), 'utf8').replace(/\r\n/g, '\n');
const DOMAIN = 'apps/api/src/meri/meri-federal-legislation-tools.ts';
const INPUT = 'apps/api/src/meri/meri-tool-input.helpers.ts';
const BILL_TEXT = 'apps/api/src/meri/meri-bill-text-search.ts';
const SERVICE = 'apps/api/src/meri/meri-tools.service.ts';
const domainSource = read(DOMAIN), inputSource = read(INPUT), billTextSource = read(BILL_TEXT);
const serviceSource = read(SERVICE);
const HANDLERS = ['searchCongressBills', 'readBillText', 'getBillStatus', 'searchFloorVotes', 'searchCboCostEstimates'];
const INPUT_NAMES = ['UUID_V4_RE', 'requiredString', 'optionalString', 'clampInt'];
const SHARED_NAMES = ['formatBillId', 'isValidCanonicalId', 'normalizeCanonicalId', 'parseBillDesignation', 'currentCongress', 'billStatusLabel'];
const BILL_NAMES = ['BILL_TEXT_BILLS_PER_PAGE', 'BILL_TEXT_MAX_BILLS_PER_PAGE', 'BILL_TEXT_PAGE_CHARS',
  'BILL_TEXT_PASSAGE_SEARCH_SQL', 'billTextCursor', 'billTextSearchResponse', 'locateBillTextPassages'];
const dataUrl = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');

// Deliberately fixture-only; no native framework/shared-root import is hidden.
const fixtureUrl = dataUrl(`
export class BadRequestException extends Error {
  constructor(message) { super(message); this.name = 'BadRequestException'; }
  getStatus() { return 400; }
}
export const normalizeCanonicalId = (kind, value) => kind === 'bioguide'
  ? value.trim().toUpperCase() : value.trim().toLowerCase();
export const isValidCanonicalId = (kind, value) => kind === 'bioguide'
  ? /^[A-Z][0-9]{6}$/.test(value) : /^[0-9]{3}-(?:hr|s|hres|sres|hjres|sjres|hconres|sconres)-[0-9]+$/.test(value);
export const currentCongress = () => 119;
export const parseBillDesignation = (value, congress) => {
  const match = /^H[.]R[.]\\s*([0-9]+)$/i.exec(value.trim());
  return match ? { congress, type: 'hr', number: Number(match[1]) } : null;
};
export const formatBillId = (congress, type, number) => congress + '-' + type + '-' + number;
export const billStatusLabel = status => 'fixture-status:' + status;
`);

/** A finite binding substitution, not an import-stripping escape hatch. */
function bindImports(javascript, bindings) {
  assert.doesNotMatch(javascript, /\b(?:require|import)\s*\(/, 'no dynamic/require port in isolated source');
  const pattern = /^import\s+([\s\S]*?)\s+from\s*(['"])([^'"]+)\2\s*;?/gm;
  const rows = [...javascript.matchAll(pattern)];
  assert.equal((javascript.match(/^import\b/gm) ?? []).length, rows.length, 'only explicit named from-imports');
  assert.equal(rows.length, bindings.size, 'complete finite import ownership');
  const seen = new Set();
  for (const [, clause, , specifier] of rows) {
    assert(bindings.has(specifier), 'unowned import: ' + specifier);
    assert(!seen.has(specifier), 'duplicate import owner: ' + specifier); seen.add(specifier);
    assert(clause.trim().startsWith('{') && clause.trim().endsWith('}'), 'named imports only');
    const names = clause.trim().slice(1, -1).split(',').map(name => name.trim()).filter(Boolean);
    assert.deepEqual(names.sort(), [...bindings.get(specifier).names].sort(), 'exact external binding names: ' + specifier);
  }
  return javascript.replace(pattern, (_match, clause, _quote, specifier) =>
    `import ${clause} from ${JSON.stringify(bindings.get(specifier).url)};`);
}
function isolatedUrl(source, bindings) {
  return dataUrl(bindImports(stripTypeScriptTypes(source, { mode: 'strip' }), bindings));
}
function facadeMethods(source) {
  return HANDLERS.map(name => {
    const matches = [...source.matchAll(new RegExp('^  private async ' + name + '\\(input: Record<string, unknown>\\) \\{\\n([\\s\\S]*?)\\n  \\}', 'gm'))];
    assert.equal(matches.length, 1, name + ': one current private facade');
    assert.equal(matches[0][1].trim(), `return new MeriFederalLegislationTools(this.prisma, this.ldaIntel).${name}(input);`,
      name + ': per-call canonical owner, same raw input, no copied body/cache');
    return matches[0][0].replace('private async ', 'async ');
  });
}
function inspectOwnership(service, domain, leaf) {
  const methods = facadeMethods(service);
  assert.match(service, /^import \{ MeriFederalLegislationTools \} from '\.\/meri-federal-legislation-tools\.js';$/m);
  assert.match(service, /^import \{ UUID_V4_RE, requiredString, optionalString, clampInt \} from '\.\/meri-tool-input\.helpers\.js';$/m);
  for (const name of ['requiredString', 'optionalString', 'clampInt']) {
    assert.doesNotMatch(service, new RegExp('^function ' + name + '\\(', 'm'), name + ': no duplicate implementation');
    assert.match(leaf, new RegExp('^export function ' + name + '\\(', 'm'));
  }
  assert.doesNotMatch(service, /^const UUID_V4_RE\s*=/m, 'UUID pattern has one input owner');
  assert.match(leaf, /^export const UUID_V4_RE\s*=/m);
  assert.doesNotMatch(domain, /^@|\b(?:Injectable|Module|OnModuleInit)\b/m, 'undecorated domain');
  const names = [...domain.matchAll(/^  (?:(?:public|private)\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\(/gm)]
    .map(match => match[1]).filter(name => name !== 'constructor').sort();
  assert.deepEqual(names, [...HANDLERS, 'resolveBillId', 'locatedBillText'].sort());
  return methods;
}
const methods = inspectOwnership(serviceSource, domainSource, inputSource);
const inputUrl = isolatedUrl(inputSource, new Map([
  ['@nestjs/common', { url: fixtureUrl, names: ['BadRequestException'] }],
]));
const billUrl = isolatedUrl(billTextSource, new Map());
const domainUrl = isolatedUrl(domainSource, new Map([
  ['@nestjs/common', { url: fixtureUrl, names: ['BadRequestException'] }],
  ['@capiro/shared', { url: fixtureUrl, names: SHARED_NAMES }],
  ['./meri-bill-text-search.js', { url: billUrl, names: BILL_NAMES }],
  ['./meri-tool-input.helpers.js', { url: inputUrl, names: INPUT_NAMES }],
]));
const inputs = await import(inputUrl);
const billText = await import(billUrl);
const { MeriFederalLegislationTools: Domain } = await import(domainUrl);
const facadeSource = `import { MeriFederalLegislationTools } from ${JSON.stringify(domainUrl)};
export class CurrentFacade {\n${methods.join('\n')}\n}`;
const { CurrentFacade } = await import(dataUrl(stripTypeScriptTypes(facadeSource, { mode: 'strip' })));

function spy(implementation = () => undefined) {
  const calls = [];
  const fn = async (...args) => { calls.push(args); return implementation(...args); };
  fn.calls = calls;
  return fn;
}
function harness(patch = {}) {
  const prisma = {
    congressBill: { findUnique: spy(() => null) },
    congressBillAction: { findMany: spy(() => []) },
    rollCallVote: { findMany: spy(() => []) },
    billRuleLink: { findMany: spy(() => []) },
    congressMember: { findUnique: spy(() => null), findMany: spy(() => []) },
    cboCostEstimate: { findMany: spy(() => []) },
    $queryRawUnsafe: spy(() => []),
  };
  for (const [key, value] of Object.entries(patch)) {
    prisma[key] = value && typeof value === 'object' ? { ...prisma[key], ...value } : value;
  }
  const ldaIntel = { getCongressBills: spy(() => ({ data: [], total: 0 })) };
  return { prisma, ldaIntel, subject: new Domain(prisma, ldaIntel) };
}
const BILL_ID = '119-hr-8800';
const REVISION = '11111111-1111-4111-8111-111111111111';
const HASH = 'a'.repeat(64);
const currentRow = (text = 'Exact current bill text.', extra = {}) => ({
  revisionId: REVISION, sourceKey: 'govinfo:BILLS-119hr8800ih', provider: 'govinfo',
  packageId: 'BILLS-119hr8800ih', billId: BILL_ID, versionCode: 'ih', lineageKey: 'bill-text:119-hr-8800',
  contentHash: 'b'.repeat(64), extractionHash: HASH, sourceUrl: 'https://example.test/current-bill',
  sourceModifiedAt: null, publishedAt: null, fetchedAt: new Date('2026-10-01T00:00:00Z'), extractedText: text, ...extra,
});
const billRow = extra => ({ id: BILL_ID, title: 'Fixture federal bill', congress: 119, status: 'introduced',
  statusAt: null, latestActionText: 'Introduced', latestActionDate: null,
  sponsorName: 'Fixture sponsor', sponsorBioguideId: 'A000001', cosponsorsCount: 0, ...extra });
function frozen(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
}

test('canonical input leaf retains trim/cap/required/integer/UUID behavior without mutating callers', () => {
  const value = frozen({ text: '  abcdef  ', absent: 12 });
  assert.equal(inputs.optionalString(value, 'text', 3), 'abc');
  assert.equal(inputs.optionalString(value, 'absent', 3), null);
  assert.equal(inputs.optionalString({ text: '  ' }, 'text', 3), null);
  assert.equal(inputs.requiredString(value, 'text', 4), 'abcd');
  assert.throws(() => inputs.requiredString({}, 'billId', 60), /billId is required/);
  assert.equal(inputs.clampInt('9.8', 1, 5, 3), 5);
  assert.equal(inputs.clampInt(-2, 1, 5, 3), 1);
  assert.equal(inputs.clampInt('not-a-number', 1, 5, 3), 3);
  assert.equal(inputs.clampInt(Infinity, 1, 5, 3), 3);
  assert(inputs.UUID_V4_RE.test(REVISION));
  assert(!inputs.UUID_V4_RE.test(REVISION.replace('-4111-', '-1111-')));
});

test('undecorated domain construction stores explicit dependencies without reading eager ports', () => {
  const touches = [];
  const port = new Proxy({}, { get(_target, key) { touches.push(key); throw Error('eager port'); } });
  const value = new Domain(port, port);
  assert(value instanceof Domain); assert.deepEqual(touches, []);
  assert.doesNotThrow(() => new Domain(undefined, undefined));
});

test('domain input and facade ownership refuses copied bodies wrong forwarding and unowned module bindings', () => {
  assert.equal(inspectOwnership(serviceSource, domainSource, inputSource).length, 5);
  assert.throws(() => inspectOwnership(serviceSource.replace('return new MeriFederalLegislationTools(this.prisma, this.ldaIntel).readBillText(input);',
    'return new MeriFederalLegislationTools(this.prisma, this.ldaIntel).readBillText({});'), domainSource, inputSource));
  assert.throws(() => inspectOwnership(serviceSource + '\nfunction clampInt() { return 1; }\n', domainSource, inputSource));
  assert.throws(() => bindImports("import { secret } from 'node:fs';", new Map()), /ownership|unowned/);
  assert.throws(() => bindImports("import 'node:fs';", new Map()), /named from-imports/);
  assert.throws(() => bindImports('const value = require("node:fs");', new Map()), /dynamic\/require/);
});

test('title search preserves Lda positional filters limit page coercion and input immutability', async () => {
  const h = harness();
  const input = frozen({ search: '  fixture policy  ', policyArea: '  Defense  ', congress: '119', activeSince: ' 2026-01-01 ', limit: 999, page: 1000 });
  const result = await h.subject.searchCongressBills(input);
  assert.deepEqual(h.ldaIntel.getCongressBills.calls, [['fixture policy', 'Defense', 119, 100, 50, '2026-01-01']]);
  assert.equal(result.tool, 'search_congress_bills'); assert.equal(result.total, 0);
  assert.equal(h.prisma.congressBill.findUnique.calls.length, 0);
});

test('exact bill designation uses direct lookup while a missing direct record falls back honestly', async () => {
  const row = billRow({}); const h = harness({ congressBill: { findUnique: spy(() => row) } });
  const result = await h.subject.searchCongressBills({ query: ' H.R. 8800 ', limit: 0 });
  assert.deepEqual(h.prisma.congressBill.findUnique.calls, [[{ where: { id: BILL_ID } }]]);
  assert.equal(result.resolvedBy, 'bill-id'); assert.deepEqual(result.data, [row]);
  assert.equal(result.page, 1); assert.equal(result.limit, 1); assert.equal(h.ldaIntel.getCongressBills.calls.length, 0);
  const missing = harness(); await missing.subject.searchCongressBills({ query: BILL_ID });
  assert.equal(missing.prisma.congressBill.findUnique.calls.length, 1);
  assert.deepEqual(missing.ldaIntel.getCongressBills.calls[0], [BILL_ID, undefined, undefined, 1, 20, undefined]);
});

test('bill-text search keeps exact SQL and positional query congress limit offset with real paging projection', async () => {
  const rows = [{ billId: BILL_ID, versionCode: 'ih', revisionId: REVISION, extractionHash: HASH,
    startOffset: 10, endOffset: 30, rank: 1, totalBills: 23, snippet: '  research   credit  ', title: 'Fixture' }];
  const h = harness({ $queryRawUnsafe: spy(() => rows) });
  const query = 'research credit; -- fixture data, never SQL';
  const result = await h.subject.searchCongressBills({ textQuery: query, congress: 'invalid', limit: 99, page: 2 });
  assert.deepEqual(h.prisma.$queryRawUnsafe.calls, [[billText.BILL_TEXT_PASSAGE_SEARCH_SQL, query, null, 10, 10]]);
  assert.equal(result.mode, 'bill_text'); assert.equal(result.page, 2); assert.equal(result.perPage, 10);
  assert.equal(result.totalBills, 23); assert.equal(result.hasMore, true); assert.equal(result.nextPage, 3);
  assert.equal(result.results[0].passages[0].snippet, 'research credit');
  assert.deepEqual(JSON.parse(Buffer.from(result.results[0].passages[0].readCursor, 'base64url')), [BILL_ID, 'ih', REVISION, HASH, 10]);
  assert.equal(h.ldaIntel.getCongressBills.calls.length, 0);
});

test('bill status distinguishes invalid input and unavailable data without inventing status or child queries', async () => {
  const h = harness();
  const invalid = await h.subject.getBillStatus({ billId: 'not a designation' });
  assert.equal(invalid.currentStatus, 'invalid_request'); assert.equal(invalid.found, false);
  assert.equal(h.prisma.congressBill.findUnique.calls.length, 0);
  const missing = await h.subject.getBillStatus({ query: BILL_ID });
  assert.equal(missing.authoritativeOwner, 'congress_bill_status'); assert.equal(missing.currentStatus, 'unavailable');
  assert.match(missing.note, /do not describe its status from memory/);
  assert.equal(h.prisma.rollCallVote.findMany.calls.length, 0); assert.equal(h.prisma.congressBillAction.findMany.calls.length, 0);
});

test('rule-failed status preserves governing rule evidence and does not infer floor passage from absent votes', async () => {
  const h = harness({
    congressBill: { findUnique: spy(({ where }) => where.id === BILL_ID ? billRow({ status: 'rule_failed' }) : { title: 'Rule', status: 'failed', latestActionText: 'Rule rejected' }) },
    billRuleLink: { findMany: spy(() => [{ ruleBillId: '119-hres-100', source: 'fixture' }]) },
    rollCallVote: { findMany: spy(({ where }) => where.billId === BILL_ID ? [] : [{ rollNumber: 7, result: 'Failed', yeas: 1, nays: 2 }]) },
    congressBillAction: { findMany: spy(() => [{ text: 'Referred', date: null }]) },
  });
  const result = await h.subject.getBillStatus({ billId: BILL_ID });
  assert.equal(result.currentStatus, 'available'); assert.equal(result.status, 'rule_failed');
  assert.equal(result.statusLabel, 'fixture-status:rule_failed');
  assert.match(result.note, /No recorded roll-call vote on this bill itself/); assert.match(result.note, /rule governing this bill FAILED/);
  assert.deepEqual(result.floorVotes, []); assert.equal(result.governingRules[0].ruleStatus, 'failed');
  assert.equal(result.governingRules[0].ruleVotes[0].result, 'Failed');
  assert.deepEqual(h.prisma.congressBillAction.findMany.calls[0][0].where, { billId: BILL_ID });
  assert.equal(h.prisma.congressBillAction.findMany.calls[0][0].take, 15);
  assert.equal(h.prisma.rollCallVote.findMany.calls[1][0].take, 3);
});

test('status with recorded floor votes returns their actual totals without a fabricated absence note', async () => {
  const vote = { chamber: 'house', result: 'Passed', yeas: 300, nays: 100, partyTotals: { fixture: true } };
  const h = harness({ congressBill: { findUnique: spy(() => billRow({ status: 'passed_house' })) },
    rollCallVote: { findMany: spy(() => [vote]) } });
  const result = await h.subject.getBillStatus({ billId: BILL_ID });
  assert.deepEqual(result.floorVotes, [vote]); assert.equal(result.note, undefined);
  assert.equal(result.statusLabel, 'fixture-status:passed_house');
});

test('floor vote filters preserve canonical member/LIS alternatives query chamber congress and bound', async () => {
  const member = { bioguideId: 'V000128', lisId: 'S128', fullName: 'Fixture Member', chamber: 'senate', state: 'MD' };
  const h = harness({ congressMember: { findUnique: spy(() => member) }, rollCallVote: { findMany: spy(() => [{ id: 'vote' }]) } });
  const input = frozen({ billId: BILL_ID, query: ' oversight ', chamber: 'SENATE', congress: '119', member: 'v000128', limit: 999 });
  const result = await h.subject.searchFloorVotes(input);
  const selection = h.prisma.rollCallVote.findMany.calls[0][0];
  assert.equal(selection.take, 25); assert.equal(selection.where.billId, BILL_ID); assert.equal(selection.where.chamber, 'senate');
  assert.equal(selection.where.congress, 119); assert.deepEqual(selection.where.OR,
    [{ question: { contains: 'oversight', mode: 'insensitive' } }, { title: { contains: 'oversight', mode: 'insensitive' } }]);
  assert.deepEqual(selection.where.memberVotes, { some: { OR: [{ bioguideId: 'V000128' }, { lisId: 'S128' }] } });
  assert.deepEqual(selection.select.memberVotes.where.OR, [{ bioguideId: 'V000128' }, { lisId: 'S128' }]);
  assert.deepEqual(result.member, { bioguideId: 'V000128', fullName: 'Fixture Member' }); assert.equal(result.votesFound, 1);
});

test('ambiguous vote member names return candidates and never query unattributed roll calls', async () => {
  const members = ['A000001', 'B000002'].map((id, index) => ({ bioguideId: id, fullName: 'Scott ' + index,
    chamber: 'senate', state: index ? 'SC' : 'FL', party: 'R', isCurrent: true }));
  const h = harness({ congressMember: { findMany: spy(() => members) } });
  const result = await h.subject.searchFloorVotes({ member: 'Scott' });
  assert.equal(result.votesFound, 0); assert.deepEqual(result.votes, []); assert.equal(result.ambiguousMember.length, 2);
  assert.match(result.note, /ask the user which/); assert.match(result.note, /NOT scoped to a member yet/);
  assert.equal(h.prisma.rollCallVote.findMany.calls.length, 0); assert.equal(h.prisma.congressMember.findMany.calls[0][0].take, 8);
});

test('unknown member IDs and names fail honestly rather than widening the vote query', async () => {
  for (const member of ['A000001', 'Nobody Boundary Fixture']) {
    const h = harness(); const result = await h.subject.searchFloorVotes({ member });
    assert.equal(result.votesFound, 0); assert.match(result.note, /NOT scoped/);
    assert.equal(h.prisma.rollCallVote.findMany.calls.length, 0);
  }
});

test('bill-text ID query/cursor and malformed scoped cursor failures occur before SQL reads', async () => {
  const h = harness();
  const valid = billText.billTextCursor(BILL_ID, 'ih', REVISION, HASH, 3);
  const variants = [
    { billId: '' }, { billId: 'not a bill' }, { billId: BILL_ID, query: 'research', cursor: valid },
    { billId: BILL_ID, cursor: valid + '=' }, { billId: BILL_ID, cursor: '***' },
    { billId: BILL_ID, versionCode: 'eh', cursor: valid },
    { billId: BILL_ID, cursor: billText.billTextCursor('119-hr-9', 'ih', REVISION, HASH, 3) },
    { billId: BILL_ID, cursor: billText.billTextCursor(BILL_ID, 'ih', REVISION, HASH, 0) },
  ];
  for (const input of variants) await assert.rejects(h.subject.readBillText(input), /required|exact canonical|query or cursor|Invalid or stale/);
  assert.equal(h.prisma.$queryRawUnsafe.calls.length, 0);
});

test('bill-text reads exact current complete ownership and returns untrusted provenance plus honest coverage', async () => {
  const row = currentRow(); const h = harness({ $queryRawUnsafe: spy(() => [row]) });
  const result = await h.subject.readBillText({ billId: BILL_ID });
  const [sql, ...args] = h.prisma.$queryRawUnsafe.calls[0];
  assert.match(sql, /FROM federal_evidence_current c/); assert.match(sql, /JOIN federal_evidence_revision r/);
  assert.match(sql, /c\.state = 'present'/); assert.match(sql, /r\.completeness = 'complete'/);
  assert.match(sql, /r\.version_code IS NOT NULL/); assert.match(sql, /LIMIT 20/); assert.deepEqual(args, [BILL_ID, null]);
  assert.equal(result.authoritativeOwner, 'federal_evidence_current'); assert.equal(result.currentStatus, 'available');
  assert.equal(result.trust, 'external_untrusted'); assert.equal(result.text, row.extractedText);
  assert.equal(result.revisionId, REVISION); assert.equal(result.versionHash, row.contentHash); assert.equal(result.textHash, HASH);
  assert.equal(result.coverage.contentComplete, true); assert.equal(result.coverage.paginationComplete, true);
  assert.equal(result.coverage.nextCursor, null);
  const empty = harness(); const missing = await empty.subject.readBillText({ billId: BILL_ID, versionCode: 'eh' });
  assert.equal(missing.currentStatus, 'unavailable'); assert.equal(missing.found, false);
  assert.match(missing.note, /No current complete bill-text revision eh/);
});

test('bill-text continuations bind exact revision/hash/offset and refuse changed or out-of-range text', async () => {
  const row = currentRow('Exact revision text');
  const cursor = billText.billTextCursor(BILL_ID, 'ih', REVISION, HASH, 3);
  const h = harness({ $queryRawUnsafe: spy(() => [row]) });
  const result = await h.subject.readBillText({ billId: BILL_ID, cursor });
  assert.equal(result.text, row.extractedText.slice(3)); assert.equal(result.coverage.locator.offset, 3);
  assert.equal(result.coverage.contentComplete, false); assert.equal(result.coverage.truncated, true);
  const stale = harness({ $queryRawUnsafe: spy(() => [currentRow('Changed', { extractionHash: 'c'.repeat(64) })]) });
  await assert.rejects(stale.subject.readBillText({ billId: BILL_ID, cursor }), /changed since the previous page/);
  await assert.rejects(h.subject.readBillText({ billId: BILL_ID, cursor: billText.billTextCursor(BILL_ID, 'ih', REVISION, HASH, 999) }), /outside the current revision/);
  const removed = harness({ $queryRawUnsafe: spy(() => []) });
  assert.equal((await removed.subject.readBillText({ billId: BILL_ID, cursor })).currentStatus, 'unavailable');
});

test('bill-text page boundaries never split a surrogate pair and continuation reconstructs the exact string', async () => {
  const text = 'x'.repeat(billText.BILL_TEXT_PAGE_CHARS - 1) + '\u{1F600}tail';
  const h = harness({ $queryRawUnsafe: spy(() => [currentRow(text)]) });
  const first = await h.subject.readBillText({ billId: BILL_ID });
  assert.equal(first.text.length, billText.BILL_TEXT_PAGE_CHARS - 1);
  assert.equal(first.coverage.paginationComplete, false);
  const decoded = JSON.parse(Buffer.from(first.coverage.nextCursor, 'base64url'));
  assert.deepEqual(decoded, [BILL_ID, 'ih', REVISION, HASH, billText.BILL_TEXT_PAGE_CHARS - 1]);
  const second = await h.subject.readBillText({ billId: BILL_ID, cursor: first.coverage.nextCursor });
  assert.equal(first.text + second.text, text); assert.equal(second.text, '\u{1F600}tail');
  assert.equal(second.coverage.paginationComplete, true); assert.equal(second.coverage.contentComplete, false);
});

test('located bill-text passages use the real locator and carry exact-revision read cursors with partial coverage', async () => {
  const text = 'SEC. 1. PURPOSE\n' + 'baseline '.repeat(200) + '\nSEC. 2. RESEARCH CREDIT\nResearch credit applies to this fixture.';
  const h = harness({ $queryRawUnsafe: spy(() => [currentRow(text)]) });
  const result = await h.subject.readBillText({ billId: BILL_ID, query: '"research credit"' });
  assert(result.totalHits >= 1); assert(result.passages.length > 0); assert.deepEqual(result.queryParts, ['research credit']);
  assert.equal(result.coverage.complete, false); assert.equal(result.coverage.truncated, true); assert.equal(result.coverage.nextCursor, null);
  assert.match(result.text.toLowerCase(), /research credit/);
  for (const passage of result.passages) {
    assert(passage.endOffset > passage.startOffset);
    if (passage.startOffset) assert.deepEqual(JSON.parse(Buffer.from(passage.readCursor, 'base64url')),
      [BILL_ID, 'ih', REVISION, HASH, passage.startOffset]);
  }
});

test('located-text no-match is an explicit excerpt result rather than evidence the bill lacks the topic', async () => {
  const h = harness({ $queryRawUnsafe: spy(() => [currentRow()]) });
  const result = await h.subject.readBillText({ billId: BILL_ID, query: 'unmatchedboundaryphrase' });
  assert.deepEqual(result.passages, []); assert.equal(result.totalHits, 0); assert.equal(result.found, true);
  assert.match(result.note, /Try other wording/); assert.equal(result.coverage.complete, false);
});

test('CBO filters retain literal IDs ordering bound and explicit missing-estimate honesty', async () => {
  const row = { id: '62540', billId: BILL_ID, title: 'Fixture score', cboUrl: 'https://example.test/cbo' };
  const h = harness({ cboCostEstimate: { findMany: spy(() => [row]) } });
  const result = await h.subject.searchCboCostEstimates({ billId: ' 119-HR-8800 ', query: ' defense ', congress: '119', limit: 999 });
  const selection = h.prisma.cboCostEstimate.findMany.calls[0][0];
  assert.deepEqual(selection.where, { billId: BILL_ID, congress: 119, title: { contains: 'defense', mode: 'insensitive' } });
  assert.equal(selection.take, 25); assert.deepEqual(selection.orderBy, { pubDate: 'desc' });
  assert.equal(result.estimatesFound, 1); assert.deepEqual(result.estimates, [row]); assert.equal(result.note, undefined);
  const missing = await harness().subject.searchCboCostEstimates({ billId: BILL_ID });
  assert.equal(missing.estimatesFound, 0); assert.match(missing.note, /No CBO cost estimate on record/); assert.match(missing.note, /do not estimate or guess/);
});

test('actual facade methods support prototype receivers plain prisma CBO seams and fresh per-call dependencies', async () => {
  const first = harness({ cboCostEstimate: { findMany: spy(() => [{ id: 'first' }]) } });
  const second = harness({ cboCostEstimate: { findMany: spy(() => [{ id: 'second' }]) } });
  const receiver = Object.assign(Object.create(CurrentFacade.prototype), { prisma: first.prisma, ldaIntel: first.ldaIntel });
  assert.equal((await receiver.searchCboCostEstimates({})).estimates[0].id, 'first');
  receiver.prisma = second.prisma;
  assert.equal((await receiver.searchCboCostEstimates({})).estimates[0].id, 'second');
  const plain = await CurrentFacade.prototype.searchCboCostEstimates.call({ prisma: first.prisma }, {});
  assert.equal(plain.estimates[0].id, 'first');
  assert.equal(first.prisma.cboCostEstimate.findMany.calls.length, 2); assert.equal(second.prisma.cboCostEstimate.findMany.calls.length, 1);
});

test('all five real domain handlers leave frozen input objects unchanged', async () => {
  for (const name of HANDLERS) {
    const h = harness();
    const input = frozen({ billId: BILL_ID, query: 'ordinary keyword', limit: 5, page: 1 });
    const before = structuredClone(input);
    await h.subject[name](input); assert.deepEqual(input, before, name);
  }
});

test('all five domain and actual facade handlers propagate identical port errors without swallowing them', async () => {
  for (const name of HANDLERS) {
    const failure = new Error('fixture-' + name);
    const fail = spy(() => { throw failure; });
    const h = harness({ congressBill: { findUnique: fail }, rollCallVote: { findMany: fail },
      cboCostEstimate: { findMany: fail }, $queryRawUnsafe: fail });
    const input = { billId: BILL_ID, query: name === 'searchCongressBills' ? BILL_ID : undefined };
    await assert.rejects(h.subject[name](input), error => error === failure, name + ': domain');
    const receiver = Object.assign(Object.create(CurrentFacade.prototype), { prisma: h.prisma, ldaIntel: h.ldaIntel });
    await assert.rejects(receiver[name](input), error => error === failure, name + ': actual facade');
  }
});

const RETIRED = ['outreachContext', 'outreachVoiceFewShots', 'batchRecipientCorrespondence',
  'persistOutreachHold', 'enrichOutreachContextItems', 'recentClientMeetingsForOutreach', 'peTruthBlock',
  'outreachClientPeopleBlock', 'outreachClientTargetOfficesBlock', 'outreachTargetRecommendations'];
const engagementSource = read('apps/api/src/engagement/engagement.service.ts');
// Bounded source contract, not a TypeScript compiler or a global call graph.
const withoutComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\r\n]*/gm, '');
function retiredRootsAbsent(source) {
  const body = withoutComments(source);
  for (const name of RETIRED) {
    assert.doesNotMatch(body, new RegExp('^\\s+(?:private|protected|public)\\s+(?:async\\s+)?' + name + '\\s*\\(', 'm'), name + ': private declaration retired');
    assert.doesNotMatch(body, new RegExp('\\bthis\\s*(?:\\.\\s*' + name + '|\\[\\s*[\'"]' + name + '[\'"]\\s*\\])\\s*\\('), name + ': direct call retired');
  }
}
function retainedEngagementSeams(ports) {
  const body = withoutComments(ports.engagement);
  const evidence = withoutComments(ports.evidence);
  const packet = withoutComments(ports.packet);
  const gateway = withoutComments(ports.gateway);
  assert.match(body, /^  async\s+billTruthBlock\s*\(/m);
  assert.match(body, /return\s+this\.truth\.billTruthBlock\(billId\)/);
  assert.match(body, /export\s+function\s+scrubPiiForVoice\s*\(/);
  assert.match(body, /private\s+async\s+buildGatewayEnrichment\s*\(/);
  assert.match(body, /this\.buildGatewayEnrichment\s*\(/);
  assert.match(body, /this\.gateway\.generate\(ctx,\s*request,\s*enrichment,\s*identity\.creds\)/);
  assert.match(gateway, /this\.packets\.compileOutreachPacket\(ctx,\s*\{/);
  assert.match(gateway, /request\.authHeader\s*\?\s*\{\s*authHeader:\s*request\.authHeader\s*\}/);
  assert.match(gateway, /if\s*\(packet\.criticalFailureCount\s*>\s*0\)/);
  assert.match(gateway, /error:\s*'CRITICAL_SOURCE_FAILURE'/);
  const criticalGate = gateway.indexOf('packet.criticalFailureCount');
  const planning = gateway.indexOf('this.plans.buildPlan(');
  assert(criticalGate >= 0 && planning > criticalGate, 'critical-source gate precedes current plan/provider path');
  assert.match(packet, /this\.sources\.resolveSelectedItems\(ctx,\s*\{/);
  assert.match(packet, /authHeader:\s*request\.authHeader/);
  assert.match(evidence, /async\s+resolveSelectedItems\s*\(/);
  assert.match(evidence, /await\s+this\.resolveOne\(ctx,\s*item,\s*input\)/);
  assert.match(evidence, /return\s+this\.resolveIntelAlert\(item,\s*input\)/);
  assert.match(evidence, /this\.alertPacketClient\.fetchAlertPacket\(\s*input\.authHeader,\s*input\.clientId,\s*alertId,?\s*\)/);
  assert.match(evidence, /renderAlertPacketForOutreach\(packet\)/);
  assert.match(ports.channels, /import\s*\{[^}]*scrubPiiForVoice[^}]*\}/);
  assert.match(ports.channels, /\bscrubPiiForVoice\s*\(/);
}

test('retired Engagement outreach roots have no private declarations or direct calls and counterexamples fail', () => {
  assert.equal(RETIRED.length, 10);
  retiredRootsAbsent(engagementSource);
  for (const name of RETIRED) {
    for (const addition of [`\n  private async ${name}() { return null; }\n`, `\nthis.${name}();\n`, `\nthis['${name}']();\n`, `\nthis["${name}"]();\n`]) {
      assert.throws(() => retiredRootsAbsent(engagementSource + addition));
    }
  }
  assert.doesNotThrow(() => retiredRootsAbsent('// unrelated future Engagement comment\n' + engagementSource));
});

test('current Engagement evidence bill truth voice scrubber and gateway seams remain free of a whole-file freeze', () => {
  const ports = {
    engagement: engagementSource,
    evidence: read('apps/api/src/engagement/generation/evidence-source.service.ts'),
    packet: read('apps/api/src/engagement/generation/evidence-packet.service.ts'),
    gateway: read('apps/api/src/engagement/generation/generation-gateway.service.ts'),
    channels: read('apps/api/src/engagement/outreach-channels.spec.ts'),
  };
  retainedEngagementSeams(ports);
  assert.doesNotThrow(() => retainedEngagementSeams({ ...ports,
    engagement: '// unrelated future Engagement comment\n' + ports.engagement }));
  assert.throws(() => retainedEngagementSeams({ ...ports,
    engagement: ports.engagement.replace(/async billTruthBlock\(/, 'async renamedBillTruthBoundaryProbe(') }));
  assert.throws(() => retainedEngagementSeams({ ...ports,
    engagement: ports.engagement.replace(/this\.gateway\.generate\(/, 'this.gateway.removedBoundaryProbe(') }));
  assert.throws(() => retainedEngagementSeams({ ...ports,
    evidence: ports.evidence.replace(/this\.alertPacketClient\.fetchAlertPacket\(/, 'this.alertPacketClient.removedBoundaryProbe(') }));
  assert.throws(() => retainedEngagementSeams({ ...ports,
    packet: ports.packet.replace(/this\.sources\.resolveSelectedItems\(/, 'this.sources.removedBoundaryProbe(') }));
  assert.throws(() => retainedEngagementSeams({ ...ports,
    gateway: ports.gateway.replace(/packet\.criticalFailureCount > 0/, 'packet.criticalFailureCount < 0') }));
  assert.throws(() => retainedEngagementSeams({ ...ports,
    channels: ports.channels.replace(/\bscrubPiiForVoice\b/g, 'removedVoiceBoundaryProbe') }));
});
