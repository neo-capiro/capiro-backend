/** SOURCE ONLY. No driver, environment, connection, mutation or CLI.
 * Parent injects read(context, sql, params) from its existing isolated actual-role
 * harness. It authenticates as capiro_private_query_ro, starts READ ONLY,
 * applies all six production local GUCs/bypass off/pg_catalog search path,
 * materializes rows then commits or rolls back. Never SET ROLE from an admin.
 * Fixture is synthetic and parent-created as specified in QUALIFICATION.md.
 */
import assert from 'node:assert/strict';

export const contactParityInputs = Object.freeze([
  ' \tPerson@EXAMPLE.INVALID\r\n', '\u00a0Mixed@Example.Invalid\uFEFF',
  '\u2000\u2028Accent\u00c9@EXAMPLE.INVALID\u3000',
  '\u0130@EXAMPLE.INVALID', '\u039f\u03a3@EXAMPLE.INVALID', '\u03a3\u039f\u03a3@EXAMPLE.INVALID',
  '\u1e9e@EXAMPLE.INVALID', 'I@EXAMPLE.INVALID', '\u0131@EXAMPLE.INVALID',
  '\u212a@EXAMPLE.INVALID', '\u{10400}@EXAMPLE.INVALID', '', ' \t\n',
]);
const countSql = relation => 'SELECT count(*)::text AS n FROM meri_private.' + relation;
const n = rows => Number(rows[0]?.n);
const researchRelations = ['research_portfolios', 'research_portfolio_members'];
const classic = 'classic_outreach_records';

export async function qualifyDomainReads(read, f) {
  const common = { tenantId: f.tenantId, actorId: f.viewerId, clientId: null };
  const research = { ...common, scopeKind: 'research_portfolio', researchPortfolioId: f.portfolioId };
  const classicContext = { ...common, scopeKind: 'classic_outreach', classicOutreachIds: f.eligibleIds };
  const role = await read(research, 'SELECT current_user::text AS current_role, session_user::text AS login_role', []);
  assert.deepEqual(role, [{ current_role: 'capiro_private_query_ro', login_role: 'capiro_private_query_ro' }]);
  for (const [actorId, expectedRole] of [[f.viewerId, 'viewer'], [f.editorId, 'editor'], [f.ownerId, 'owner']]) {
    assert.deepEqual(await read({ ...research, actorId },
      'SELECT portfolio_id::text, my_role, lifecycle FROM meri_private.research_portfolios', []),
    [{ portfolio_id: f.portfolioId, my_role: expectedRole, lifecycle: 'archived' }]);
  }
  assert.deepEqual(await read(research,
    'SELECT target_id, disposition, label, reason FROM meri_private.research_portfolio_members ORDER BY target_id', []), f.expectedMembers);
  for (const actorId of [f.noGrantId, f.inactiveMemberId, f.foreignActorId]) {
    for (const relation of researchRelations) assert.equal(n(await read({ ...research, actorId }, countSql(relation), [])), 0);
  }
  for (const context of [{ ...common, scopeKind: 'general' }, { ...common, scopeKind: 'client', clientId: f.clientId },
    classicContext, { ...research, researchPortfolioId: f.foreignPortfolioId }]) {
    for (const relation of researchRelations) assert.equal(n(await read(context, countSql(relation), [])), 0);
  }
  for (const relation of f.clientRelations) assert.equal(n(await read(research, countSql(relation), [])), 0);
  for (const size of [0, 1, 100]) {
    const context = { ...classicContext, classicOutreachIds: f.eligibleIds.slice(0, size) };
    assert.equal(n(await read(context, countSql(classic), [])), size);
  }
  for (const context of [research, { ...common, scopeKind: 'general' }, { ...common, scopeKind: 'client', clientId: f.clientId }])
    assert.equal(n(await read(context, countSql(classic), [])), 0);
  const selected = await read({ ...classicContext, clientId: f.clientId },
    'SELECT id::text FROM meri_private.classic_outreach_records ORDER BY id', []);
  assert.deepEqual(selected.map(row => row.id), f.selectedClientIds.toSorted());
  const withIneligible = { ...classicContext, classicOutreachIds: [...f.eligibleIds.slice(0, 1), ...f.sqlExcludedIds] };
  assert.equal(n(await read(withIneligible, countSql(classic), [])), 1);
  assert.deepEqual(await read(classicContext,
    'SELECT status, count(*)::text AS n FROM meri_private.classic_outreach_records GROUP BY status ORDER BY status', []), f.expectedStatusCounts);
  for (const relation of f.rawSourceTables.concat(['meri_private.visible_clients'])) {
    await assert.rejects(() => read(research, 'SELECT * FROM ' + relation + ' LIMIT 0', []), error => error?.code === '42501');
  }
}

/** Direct GUC adapter bypasses TypeScript validation ONLY in isolated negative qualification. */
export async function qualifyMalformedClassicSettings(readSetting, context, oneId) {
  for (const setting of [null, '', 'bad', oneId + ',', ',' + oneId, oneId + ',' + oneId,
    'ABCDEFAB-0000-4000-8000-000000000001', Array(101).fill(oneId).join(',')]) {
    assert.equal(n(await readSetting(context, setting, countSql(classic))), 0);
  }
}

/** Compare actual root ICU normalization to canonical JS, including dotted I,
 * contextual final sigma and supplementary-plane case. Also compare saved
 * meeting associations to canonical Prisma under the actual citext locale. */
export async function qualifyContactLowercase(read, context) {
  const sql = "SELECT pg_catalog.lower(pg_catalog.btrim($1::text, " +
    "U&'\\0009\\000A\\000B\\000C\\000D\\0020\\00A0\\1680\\2000\\2001\\2002\\2003\\2004\\2005\\2006\\2007\\2008\\2009\\200A\\2028\\2029\\202F\\205F\\3000\\FEFF')" +
    ' COLLATE pg_catalog."und-x-icu") AS normalized';
  for (const input of contactParityInputs) {
    const rows = await read(context, sql, [input]);
    assert.equal(rows[0]?.normalized, input.trim().toLowerCase());
  }
}
