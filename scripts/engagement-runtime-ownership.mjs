#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_FIXTURE = path.join(
  ROOT,
  'infra/cdk/fixtures/engagement-runtime-ownership.v1.json',
);

const CONCERNS = ['workers', 'callbacks', 'recall', 'externalActions'];
const SERVICES = ['api', 'engagement-api'];

export function deriveOwners(profile) {
  const services = Object.values(profile.services ?? {});
  return {
    workers: services
      .filter((service) => service.backgroundOwner === service.serviceName)
      .map((service) => service.serviceName),
    callbacks: services
      .filter((service) => service.callbacksEnabled === true)
      .map((service) => service.serviceName),
    recall: services
      .filter((service) => service.recallWebhookEnabled === true)
      .map((service) => service.serviceName),
    externalActions: services
      .filter((service) => service.externalActions !== 'disabled')
      .map((service) => service.serviceName),
  };
}

export function validateOwnershipFixture(fixture) {
  const problems = [];
  if (fixture?.schemaVersion !== 1) problems.push('schemaVersion must be 1');
  for (const key of ['currentProductionProfile', 'futureRehearsalProfile']) {
    const profile = fixture?.[key];
    if (!profile) {
      problems.push(`missing ${key}`);
      continue;
    }
    const serviceNames = Object.keys(profile.services ?? {}).sort();
    if (JSON.stringify(serviceNames) !== JSON.stringify([...SERVICES].sort())) {
      problems.push(`${key} must define exactly api and engagement-api`);
      continue;
    }
    const derived = deriveOwners(profile);
    for (const concern of CONCERNS) {
      const owners = derived[concern];
      if (owners.length !== 1) {
        problems.push(`${key}.${concern} must have exactly one owner (got ${owners.join(', ') || 'none'})`);
        continue;
      }
      if (profile.owners?.[concern] !== owners[0]) {
        problems.push(
          `${key}.${concern} declares ${profile.owners?.[concern]} but derives ${owners[0]}`,
        );
      }
    }
  }

  const current = fixture?.currentProductionProfile;
  if (current) {
    if (current.productionAllowed !== true || current.testOnly !== false) {
      problems.push('currentProductionProfile must be productionAllowed and not testOnly');
    }
    for (const concern of CONCERNS) {
      if (current.owners?.[concern] !== 'api') {
        problems.push(`currentProductionProfile.${concern} must remain api`);
      }
    }
    if (current.services?.['engagement-api']?.processMode !== 'shadow') {
      problems.push('current engagement-api must remain shadow');
    }
  }

  const future = fixture?.futureRehearsalProfile;
  if (future) {
    if (future.productionAllowed !== false || future.testOnly !== true) {
      problems.push('futureRehearsalProfile must remain test-only and production-prohibited');
    }
    for (const concern of CONCERNS) {
      if (future.owners?.[concern] !== 'engagement-api') {
        problems.push(`futureRehearsalProfile.${concern} must be engagement-api`);
      }
    }
  }
  return problems;
}

export function loadOwnershipFixture(filePath = DEFAULT_FIXTURE) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function main() {
  const fixture = loadOwnershipFixture(process.argv[2] ? path.resolve(process.argv[2]) : undefined);
  const problems = validateOwnershipFixture(fixture);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`FAIL  ${problem}`);
    console.error(`\nENGAGEMENT_RUNTIME_OWNERSHIP_INVALID (${problems.length})`);
    process.exit(1);
  }
  console.log('ENGAGEMENT_RUNTIME_OWNERSHIP_VALID');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
