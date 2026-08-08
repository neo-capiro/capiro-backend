#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deriveOwners,
  loadOwnershipFixture,
  validateOwnershipFixture,
} from './engagement-runtime-ownership.mjs';

export function runRehearsal(profileName) {
  const fixture = loadOwnershipFixture();
  const problems = validateOwnershipFixture(fixture);
  if (problems.length) throw new Error(problems.join('; '));
  const profile = fixture[profileName];
  if (!profile) throw new Error(`unknown rehearsal profile ${profileName}`);
  const derived = deriveOwners(profile);
  for (const [concern, owners] of Object.entries(derived)) {
    if (owners.length !== 1) throw new Error(`${profileName}.${concern} is not single-owner`);
  }
  return { profile: profile.name, owners: profile.owners, testOnly: profile.testOnly };
}

function main() {
  const current = runRehearsal('currentProductionProfile');
  const future = runRehearsal('futureRehearsalProfile');
  if (current.owners.workers !== 'api') throw new Error('current worker owner drifted');
  if (future.owners.workers !== 'engagement-api' || future.testOnly !== true) {
    throw new Error('future rehearsal is not a test-only engagement-api transfer');
  }
  console.log(JSON.stringify({ current, future }, null, 2));
  console.log('OUTREACH_V3_P1_OWNER_REHEARSAL_COMPLETE');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
