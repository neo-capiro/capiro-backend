import { assertManifest } from './manifest.mjs';
import { assertFixtureInstanceId } from './contract.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const fail = () => {
  throw new Error('PENDING_MEMORY_FIXTURE_PLAN_INVALID');
};

/** Frozen selection only. This does not attest availability, seed or acceptance. */
export function selectPendingMemoryFixturePlan(manifest, caseId) {
  assertManifest(manifest);
  if (!['14', '17'].includes(caseId) || !manifest.fixtureInstanceId) fail();
  assertFixtureInstanceId(manifest.fixtureInstanceId);
  const actor = (key) => {
    const value = manifest.actors?.[key];
    if (value?.tenantId !== 'T1' || !UUID.test(value.physicalId ?? '')) fail();
    return value.physicalId;
  };
  const pat = actor('PAT'),
    priya = actor('PRIYA');
  if (pat === priya) fail();
  for (const key of ['ASTER', 'BLUEHAVEN'])
    if (
      manifest.clients?.[key]?.tenantId !== 'T1' ||
      !UUID.test(manifest.clients[key].physicalId ?? '')
    )
      fail();
  if (manifest.clients.ASTER.physicalId === manifest.clients.BLUEHAVEN.physicalId) fail();
  const sourceIds =
    caseId === '14'
      ? ['MEM-PROPOSAL-14']
      : [...'ABCDEF'].map((letter) => `MEM-PENDING-17-${letter}`);
  const records = sourceIds.map((id) => manifest.records.find((row) => row.logicalId === id));
  if (
    records.some(
      (row) =>
        !row ||
        row.owner !== 'memory_candidate' ||
        row.tenantKey !== 'T1' ||
        row.expectedPresence !== 'present',
    )
  )
    fail();
  return structuredClone({
    caseId,
    proposerActorId: caseId === '14' ? 'PAT' : 'PRIYA',
    proposerUserId: caseId === '14' ? pat : priya,
    reviewerActorId: caseId === '14' ? 'PRIYA' : null,
    reviewerUserId: caseId === '14' ? priya : null,
    records,
    fixtureInstanceId: manifest.fixtureInstanceId,
    manifestContentSha256: manifest.contentSha256,
  });
}
