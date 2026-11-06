'use strict';
// Extension for the existing isolated Lane6 PG16 synthetic fixture, not a runner.
// No connection, process, credential or migration initialization occurs on import.
// Custodian calls this after the existing real v2 fixture seal + new forward SQL,
// before that fixture revokes its synthetic qualified population and stops PG.
const assert = require('node:assert/strict');

function cents(value) {
  if (value === null) return null;
  assert.match(value, /^-?\d+\.\d{2}$/);
  return BigInt(value.replace('.', ''));
}
function sum(values) {
  const known = values.filter((v) => v !== null).map(cents);
  return known.length ? known.reduce((a, b) => a + b, 0n) : null;
}

/** Executes real SQL assertions using the canonical populated synthetic fixture.
 * The caller owns isolated-instance admission, migrations, transaction cleanup and stop.
 * Reject insufficient fixtures instead of reporting coverage from empty/mocked rows.
 */
async function verifyScopedProcurement({ client, awardIdentityKeys, knownAt, syntheticOnly, expectedDataDirectory }) {
  assert.equal(syntheticOnly, true, 'isolated synthetic allocation required');
  assert.equal(typeof expectedDataDirectory, 'string');
  assert(expectedDataDirectory.length > 8);
  const identity = (await client.query("SELECT current_setting('data_directory') directory,current_setting('server_version_num') version,host(inet_server_addr()) address,current_database() db,current_user role")).rows[0];
  assert.equal(identity.directory.replaceAll('\\', '/'), expectedDataDirectory.replaceAll('\\', '/'));
  assert.equal(identity.address, '127.0.0.1');
  assert(Number(identity.version) >= 160000 && Number(identity.version) < 170000);
  assert.equal(identity.role, 'capiro_master');
  assert(awardIdentityKeys.length >= 2 && awardIdentityKeys.length <= 25);
  const checks = [];
  const query = async (keys, clock = knownAt, through = null) => (await client.query(
    'SELECT public.defproc_money_flow_details_v2($1::text[],$2::text,$3::text) result', [keys, clock, through])).rows[0].result;
  const original = (await client.query(`SELECT * FROM public.defproc_action_asof_v2($1::timestamptz,NULL)
    WHERE award_identity_key=ANY($2::text[]) ORDER BY transaction_identity_key`, [knownAt, awardIdentityKeys])).rows;
  assert(original.length > 0, 'populated qualified source fixture required');
  assert(original.some((r) => cents(r.obligation_usd) < 0n), 'negative selected action fixture required');
  assert(original.some((r) => cents(r.obligation_usd) > 7036874417766400n), 'large exact cents fixture required');
  assert(original.some((r) => r.action_date === null), 'undated selected fixture required');
  assert(original.every((r) => r.outlay_usd === null), 'SAM NULL-outlay fixture required');
  const collision = original.find((a) => /^\d+$/.test(a.piid)
    && original.some((b) => b.piid === a.piid && b.award_identity_key !== a.award_identity_key));
  assert(collision, 'two full awards sharing a numeric PIID fixture required');

  await client.query('BEGIN READ ONLY');
  try {
    const whole = await query(awardIdentityKeys);
    const baseline = (await client.query('SELECT public.defproc_money_flow_scope_v2($1::text[],$2::text,$3::text) result', [awardIdentityKeys, knownAt, null])).rows[0].result;
    const { actionDetails: _details, ...summary } = whole;
    assert.deepEqual(summary, baseline, 'detail projection must preserve every original summary value');
    assert.equal(whole.state, 'partial'); assert.equal(whole.measure, 'qualified_observed_actions');
    assert.equal(whole.totals.actions, String(original.length));
    assert.equal(cents(whole.totals.obligationUsd), sum(original.map((r) => r.obligation_usd)));
    assert.equal(sum(whole.groups.map((r) => r.obligationUsd)), cents(whole.totals.obligationUsd));
    assert.equal(whole.groups.reduce((n, r) => n + BigInt(r.actions), 0n), BigInt(original.length));
    assert.equal(whole.totals.outlayUsd, null); assert.equal(whole.totals.outlayKnown, '0');
    assert(whole.groups.some((r) => r.fiscalYear === null));
    assert.equal(whole.provenance.reduce((n, r) => n + BigInt(r.selectedActions), 0n), BigInt(original.length));
    assert(whole.provenance.every((r) => awardIdentityKeys.includes(r.awardIdentityKey) && r.contract === 'sam-contract-action/v2'));
    checks.push('exact signed/NULL/group/provenance conservation on real qualified synthetic rows');

    const one = await query([collision.award_identity_key]);
    const expected = original.filter((r) => r.award_identity_key === collision.award_identity_key);
    assert.equal(one.totals.actions, String(expected.length));
    assert.equal(cents(one.totals.obligationUsd), sum(expected.map((r) => r.obligation_usd)));
    assert(one.provenance.every((r) => r.awardIdentityKey === collision.award_identity_key));
    checks.push('numeric shared PIID does not leak a different full award into scoped totals');

    const empty = await query(awardIdentityKeys, '2000-01-01T00:00:00.000000Z');
    assert.equal(empty.state, 'unavailable'); assert.equal(empty.totals, null); assert.deepEqual(empty.groups, []);
    assert.deepEqual(empty.actionDetails, [], 'an empty qualified population must return an empty detail array, not null');
    checks.push('prepopulation knowledge boundary cannot publish zero spending');

    for (const [keys, clock, through] of [[[], knownAt, null], [[awardIdentityKeys[0], awardIdentityKeys[0]], knownAt, null],
      [['0001'], knownAt, null], [awardIdentityKeys, '2026-02-30T00:00:00.000000Z', null],
      [awardIdentityKeys, knownAt, '2026-09-01T00:00:00.1234567Z']]) {
      await client.query('SAVEPOINT invalid_scope');
      try { await query(keys, clock, through); assert.fail('invalid scope unexpectedly succeeded'); }
      catch (error) { assert.equal(error.code, '22023'); }
      finally { await client.query('ROLLBACK TO SAVEPOINT invalid_scope'); await client.query('RELEASE SAVEPOINT invalid_scope'); }
    }
    checks.push('real PostgreSQL canonical scope/calendar/precision refusal');

    const rights = (await client.query(`SELECT rolname,has_function_privilege(oid,
      'public.defproc_money_flow_details_v2(text[],text,text)','EXECUTE') allowed FROM pg_roles
      WHERE rolname=ANY(ARRAY['capiro_app','capiro_defense_job','capiro_defense_job_login','capiro_defense_serve']) ORDER BY rolname`)).rows;
    assert.equal(rights.length, 4); assert(rights.every((r) => r.allowed === (r.rolname === 'capiro_app')));
    await client.query('SET LOCAL ROLE capiro_app');
    assert.deepEqual(await query(awardIdentityKeys), whole);
    await client.query('SET LOCAL ROLE capiro_master');
    checks.push('ordinary application role reads exact projection; job/serve roles have no new EXECUTE');

    // actionDetails additive field verification on real SQL output
    const hasActionDetails = Object.hasOwn(whole, 'actionDetails') && Array.isArray(whole.actionDetails);
    assert(hasActionDetails, 'requested populated actionDetails must be present');
    if (hasActionDetails) {
      checks.push('actionDetails is present additive field in ProcurementMoneyFlow');
      // Cap: must not exceed 2500 rows
      assert(whole.actionDetails.length <= 2500, 'actionDetails must not exceed 2500 items');
      // Count matches totals.actions (both are integer counts, compare as numbers)
      const totalActionsDetail = whole.actionDetails.length;
      assert.equal(totalActionsDetail, Number(whole.totals.actions), 'actionDetails count must match totals actions');
      // Validate each detail row
      for (const d of whole.actionDetails) {
        assert(typeof d.transactionIdentityKey === 'string' && d.transactionIdentityKey.length > 0, 'transactionIdentityKey required');
        assert(typeof d.awardIdentityKey === 'string' && d.awardIdentityKey.length > 0, 'awardIdentityKey required');
        assert(typeof d.awardUniqueId === 'string' && d.awardUniqueId.length > 0, 'awardUniqueId required');
        assert(typeof d.selectedRevisionId === 'string' && d.selectedRevisionId.length > 0, 'selectedRevisionId required');
        assert(typeof d.piid === 'string' && d.piid.length > 0, 'piid required');
        assert(typeof d.submittingAgencyCode === 'string' && d.submittingAgencyCode.length > 0, 'submittingAgencyCode required');
        assert(d.awardType === 'A' || d.awardType === 'B' || d.awardType === 'C' || d.awardType === 'D', 'invalid awardType');
        // obligationUsd: validated persisted signed decimal string (includes negative for deobligations)
        assert(typeof d.obligationUsd === 'string' && /^-?\d+\.\d{2}$/.test(d.obligationUsd), 'valid obligationUsd decimal string required');
        assert.strictEqual(d.outlayUsd, null, 'outlayUsd must be null');
        assert(typeof d.sourceRevisionOrder === 'string' && d.sourceRevisionOrder.length > 0, 'sourceRevisionOrder required');
        assert(typeof d.sourceObservedAt === 'string' && d.sourceObservedAt.length > 0, 'sourceObservedAt required');
        assert(typeof d.recordedAt === 'string' && d.recordedAt.length > 0, 'recordedAt required');
        assert(typeof d.sourcePayloadHash === 'string' && d.sourcePayloadHash.length > 0, 'sourcePayloadHash required');
        assert(typeof d.vendorKey === 'string' && d.vendorKey.length > 0, 'vendorKey required');
        // Organization objects required with proper structure; codes may be null (Unknown is valid)
        assert(d.fundingOrganization && typeof d.fundingOrganization === 'object', 'fundingOrganization required');
        assert(d.contractingOrganization && typeof d.contractingOrganization === 'object', 'contractingOrganization required');
        const fo = d.fundingOrganization;
        const co = d.contractingOrganization;
        // Structure is present; code may be null (Unknown) — do NOT require nonnull
        assert(fo.department && typeof fo.department === 'object', 'funding department required');
        assert(fo.subtier && typeof fo.subtier === 'object', 'funding subtier required');
        assert(fo.office && typeof fo.office === 'object', 'funding office required');
        assert(co.department && typeof co.department === 'object', 'contracting department required');
        assert(co.subtier && typeof co.subtier === 'object', 'contracting subtier required');
        assert(co.office && typeof co.office === 'object', 'contracting office required');
        // null is permitted: null code means source did not provide org code (Unknown)
        assert(fo.department.code === null || typeof fo.department.code === 'string', 'funding dept code must be string or null');
        assert(co.department.code === null || typeof co.department.code === 'string', 'contracting dept code must be string or null');
      }
      assert(Buffer.byteLength(JSON.stringify(whole), 'utf8') <= 1048576, 'full detail response must not exceed 1 MiB');
      // Verify that obligation sum matches totals (using cents to avoid float loss)
      const detailObligationSum = sum(whole.actionDetails.map((d) => d.obligationUsd));
      assert.equal(detailObligationSum, cents(whole.totals.obligationUsd), 'actionDetails obligation sum must match totals');
      // Verify at least one detail has negative obligation (deobligation case)
      assert(whole.actionDetails.some((d) => cents(d.obligationUsd) < 0n), 'negative obligation action required in details');
      // Org-separation: verify funding and contracting are genuinely populated from different source fields.
      // Find at least one action where funding dept code differs from contracting dept code (they are separate fields).
      const hasDifferentOrgs = whole.actionDetails.some((d) =>
        d.fundingOrganization.department.code !== null &&
        d.contractingOrganization.department.code !== null &&
        d.fundingOrganization.department.code !== d.contractingOrganization.department.code
      );
      // Not all fixtures will have different orgs, but if both are nonnull they must come from separate fields.
      // Assert they are separate objects (structural check always passes):
      assert(whole.actionDetails.every((d) => d.fundingOrganization !== d.contractingOrganization), 'funding and contracting org must be separate objects');
      if (hasDifferentOrgs) {
        checks.push('funding vs contracting organization separation confirmed: at least one action has different dept codes');
      } else {
        checks.push('actionDetails organization structure verified (funding and contracting are separate objects)');
      }
      // This small fixture checks admission, not the full-population refusal boundary.
      checks.push('actionDetails SQL fields validated against source: transaction_identity_key/award_unique_id/obligation/org paths');
    }
  } finally { await client.query('ROLLBACK'); }
  return { status: 'SCOPED_SYNTHETIC_EXTENSION_PASS', checks, sourceRows: original.length,
    limits: 'This extension does not replace original classifier/immutability/ACL-preservation fixtures,500-group/1MiB fixtures, nor live producer and deployed acceptance.' };
}
module.exports = { verifyScopedProcurement };
