/**
 * OLD-vs-NEW parity: the Program Element finder-list row projection.
 *
 * apps/api builds each finder row inline at the end of `listProgramElements`, using
 * `claimFromLadderPick` / `requestClaim` / `enactedClaim` /
 * `listEnactedVsRequestDeltaPct`. `apps/defense-api` calls the shared
 * `projectPeListRow`.
 *
 * The `legacyProjectRow` below is apps/api's block transcribed EXACTLY, but it
 * calls apps/api's OWN imported helpers — so this compares two real
 * implementations over identical inputs rather than asserting the new one against
 * itself. What it pins:
 *   - the full field set (a dropped enrichment field fails on the key-set assert);
 *   - every claim's money/FY/stage/vehicle/cycle/projection labelling;
 *   - the matched-pair-only percent rule (a cross-FY % must stay null);
 *   - `comparableEnactedVsRequest` presence/absence.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  claimForYearLadder as _unusedLadder,
  claimFromLadderPick,
  enactedClaim,
  requestClaim,
} from '../../apps/api/src/program-element/funding-claim.helpers.ts';
import { listEnactedVsRequestDeltaPct } from '../../packages/shared/src/funding-claim.ts';
import { projectPeListRow, type PeListSqlRow } from '@capiro/defense-domain/pe-read';

void _unusedLadder;

/** apps/api's `listProgramElements` row map, transcribed against ITS helpers. */
function legacyProjectRow(rest: PeListSqlRow) {
  const currentCycleFy = rest.peCurrentCycleFy ?? null;
  const currentClaim =
    rest.latestCurrent != null || rest.latestCurrentStage
      ? claimFromLadderPick({
          value: rest.latestCurrent,
          stage: (rest.latestCurrentStage ?? 'none') as never,
          fiscalYear: rest.latestCurrentFy,
          currentCycleFy,
        })
      : null;
  const requestClaimRow =
    rest.latestRequest != null || rest.latestRequestFy != null
      ? requestClaim(rest.latestRequest, rest.latestRequestFy, currentCycleFy)
      : null;
  const enactedClaimRow =
    rest.latestEnacted != null || rest.latestEnactedFy != null
      ? enactedClaim(rest.latestEnacted, rest.latestEnactedFy, currentCycleFy)
      : null;
  const requestAtEnactedClaimRow =
    rest.requestAtEnactedFy != null && rest.latestEnactedFy != null
      ? requestClaim(rest.requestAtEnactedFy, rest.latestEnactedFy, currentCycleFy)
      : null;
  const deltaPctClaimSafe = listEnactedVsRequestDeltaPct({
    latestEnacted: rest.latestEnacted,
    latestEnactedFy: rest.latestEnactedFy,
    requestAtEnactedFy: rest.requestAtEnactedFy,
  });
  return {
    ...rest,
    deltaPct: deltaPctClaimSafe,
    currentClaim,
    requestClaim: requestClaimRow,
    enactedClaim: enactedClaimRow,
    requestAtEnactedClaim: requestAtEnactedClaimRow,
    comparableEnactedVsRequest:
      rest.latestEnactedFy != null && rest.latestEnacted != null && rest.requestAtEnactedFy != null
        ? {
            fiscalYear: rest.latestEnactedFy,
            enacted: rest.latestEnacted,
            request: rest.requestAtEnactedFy,
            deltaPct: deltaPctClaimSafe,
          }
        : null,
  };
}

const BASE: PeListSqlRow = {
  peCode: '0604011A',
  title: 'Rehearsal Program Element',
  service: 'ARMY',
  budgetActivity: '05',
  appropriationType: 'RDTE',
  status: 'active',
  lastSyncedAt: new Date('2026-08-01T00:00:00.000Z'),
  hasData: true,
  watched: false,
  billCount: 3,
  latestRequest: null,
  latestRequestFy: null,
  latestEnacted: null,
  latestEnactedFy: null,
  requestAtEnactedFy: null,
  latestCurrent: null,
  latestCurrentFy: null,
  latestCurrentStage: null,
  peCurrentCycleFy: 2027,
  deltaPct: null,
  spark: [1, 2, 3],
  signalType: 'mark_vs_request',
  signalScore: 0.72,
  signalDeltaPct: 12.5,
  lineType: 'RDTE_PE',
  maturity: 3,
  appropTier: 'high',
  appropScore: 81,
  actionSignalType: 'add',
  actionSignalTone: 'positive',
  valleyOfDeath: false,
};

const CASES: Array<{ label: string; row: PeListSqlRow }> = [
  { label: 'no money at all', row: { ...BASE } },
  {
    label: 'matched pair, enacted above request',
    row: {
      ...BASE,
      latestRequest: 100,
      latestRequestFy: 2027,
      latestEnacted: 110,
      latestEnactedFy: 2026,
      requestAtEnactedFy: 100,
      latestCurrent: 110,
      latestCurrentFy: 2026,
      latestCurrentStage: 'enacted',
    },
  },
  {
    label: 'enacted with NO request at that FY -> percent must be null',
    row: {
      ...BASE,
      latestRequest: 100,
      latestRequestFy: 2027,
      latestEnacted: 110,
      latestEnactedFy: 2024,
      requestAtEnactedFy: null,
    },
  },
  {
    label: 'zero request base at the enacted FY -> percent must be null, not Infinity',
    row: { ...BASE, latestEnacted: 5, latestEnactedFy: 2026, requestAtEnactedFy: 0 },
  },
  {
    label: 'genuine zero enacted against a real request',
    row: { ...BASE, latestEnacted: 0, latestEnactedFy: 2026, requestAtEnactedFy: 40 },
  },
  {
    label: 'FYDP outyear current stage -> isProjection',
    row: { ...BASE, latestCurrent: 55, latestCurrentFy: 2031, latestCurrentStage: 'request' },
  },
  {
    label: 'current stage present with a null value (stage but no money)',
    row: { ...BASE, latestCurrent: null, latestCurrentFy: 2027, latestCurrentStage: 'hasc' },
  },
  {
    label: 'no cycle anchor at all -> cycleClass unknown',
    row: {
      ...BASE,
      peCurrentCycleFy: null,
      latestRequest: 10,
      latestRequestFy: 2027,
      latestCurrent: 10,
      latestCurrentFy: 2027,
      latestCurrentStage: 'request',
    },
  },
  {
    label: 'negative enacted (rescission)',
    row: { ...BASE, latestEnacted: -4, latestEnactedFy: 2026, requestAtEnactedFy: 20 },
  },
  {
    label: 'request FY present but value null',
    row: { ...BASE, latestRequest: null, latestRequestFy: 2027 },
  },
];

test('PARITY: every finder row projects identically to apps/api, field-for-field', () => {
  for (const c of CASES) {
    const legacyRow = legacyProjectRow(c.row);
    const nextRow = projectPeListRow(c.row);
    assert.deepEqual(
      Object.keys(nextRow).sort(),
      Object.keys(legacyRow).sort(),
      `field set diverged: ${c.label}`,
    );
    assert.deepEqual(nextRow, legacyRow, `row value diverged: ${c.label}`);
  }
});

test('PARITY: the finder row carries every enrichment field apps/api serves', () => {
  // Explicit inventory, so silently dropping one (the exact regression this
  // session repairs) fails here even if the transcribed legacy block were edited
  // in the same wrong direction.
  const REQUIRED = [
    'peCode', 'title', 'service', 'budgetActivity', 'appropriationType', 'status',
    'lastSyncedAt', 'hasData', 'watched', 'billCount',
    'latestRequest', 'latestRequestFy', 'latestEnacted', 'latestEnactedFy',
    'requestAtEnactedFy', 'latestCurrent', 'latestCurrentFy', 'latestCurrentStage',
    'peCurrentCycleFy', 'deltaPct', 'spark',
    'signalType', 'signalScore', 'signalDeltaPct',
    'lineType', 'maturity', 'appropTier', 'appropScore',
    'actionSignalType', 'actionSignalTone', 'valleyOfDeath',
    'currentClaim', 'requestClaim', 'enactedClaim', 'requestAtEnactedClaim',
    'comparableEnactedVsRequest',
  ];
  const produced = new Set(Object.keys(projectPeListRow(CASES[1]!.row)));
  const missing = REQUIRED.filter((f) => !produced.has(f));
  assert.deepEqual(missing, [], `finder row is missing enrichment fields: ${missing.join(', ')}`);
});

test('PARITY: a cross-FY comparison is never expressed as a percent', () => {
  const row: PeListSqlRow = {
    ...BASE,
    latestRequest: 100,
    latestRequestFy: 2027,
    latestEnacted: 110,
    latestEnactedFy: 2024,
    requestAtEnactedFy: null,
  };
  const projected = projectPeListRow(row);
  assert.equal(projected.deltaPct, null);
  assert.equal(projected.comparableEnactedVsRequest, null);
  assert.deepEqual(projected, legacyProjectRow(row));
});
