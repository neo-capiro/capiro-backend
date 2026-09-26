#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function requireRecords(value, label) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.results)) {
    throw new Error(`${label} must contain a results array`);
  }
  return value.results;
}

function caseIds(rows, prefix, count, label) {
  if (rows.length !== count) throw new Error(`${label} expected ${count} rows, found ${rows.length}`);
  const ids = new Set();
  rows.forEach((row) => {
    if (!row || typeof row !== 'object' || typeof row.testId !== 'string' || !new RegExp(`^${prefix}-[0-9]{3}$`).test(row.testId)) {
      throw new Error(`${label} contains an invalid case ID`);
    }
    if (ids.has(row.testId)) throw new Error(`${label} contains duplicate case IDs`);
    ids.add(row.testId);
  });
  const expected = Array.from({ length: count }, (_, index) => `${prefix}-${String(index + 1).padStart(3, '0')}`);
  if (expected.some((id) => !ids.has(id))) throw new Error(`${label} IDs do not match the expected case range`);
  return expected;
}

export function buildHistoricalQaIntake(readArtifact, updatedArtifact, rawReadBytes, rawUpdatedBytes) {
  const readRows = requireRecords(readArtifact, 'read artifact');
  if (readRows.some((row) => !row || typeof row.feature !== 'string' || !row.feature.trim())) {
    throw new Error('read artifact contains a row without its expected feature identifier');
  }
  const actionRows = requireRecords(updatedArtifact, 'updated artifact')
    .filter((row) => row?.category === 'Meri Approval Actions');
  if (actionRows.some((row) => row?.safetyMode !== 'MUTATION_APPROVAL' && row?.safetyMode !== 'MUTATION_IMMEDIATE')) {
    throw new Error('action-safety ledger contains an unexpected safety mode');
  }

  return {
    inventoryVersion: 'meri-historical-qa-intake.v1',
    purpose: 'privacy_safe_intake_inventory_only',
    sourceArtifacts: [
      { name: 'meri-read-results.json', sha256: sha256(rawReadBytes), recordCount: readRows.length },
      { name: 'updated-results.json', sha256: sha256(rawUpdatedBytes), recordCount: updatedArtifact.results.length },
    ],
    cohorts: [
      {
        id: 'historic_read_qa',
        sourceCategory: 'meri-read-results artifact',
        recordCount: readRows.length,
        caseIds: caseIds(readRows, 'MRO', 81, 'read QA cohort'),
      },
      {
        id: 'historic_action_safety_qa',
        sourceCategory: 'Meri Approval Actions',
        recordCount: actionRows.length,
        safetyModeCounts: Object.fromEntries(['MUTATION_APPROVAL', 'MUTATION_IMMEDIATE'].map((mode) => [
          mode, actionRows.filter((row) => row.safetyMode === mode).length,
        ])),
        caseIds: caseIds(actionRows, 'MWR', 23, 'action-safety cohort'),
      },
    ],
    separation: {
      routingCases: 0,
      independentlyAdjudicated: false,
      statusLabelsIncluded: false,
      promptsOrDisplayedContentIncluded: false,
      rawEvidenceIncluded: false,
      passLabelsAreNotFactualOrRoutingPasses: true,
      separateFromSyntheticRoutingSeed: true,
    },
  };
}

async function main() {
  const [readPath, updatedPath, outputPath] = process.argv.slice(2);
  if (!readPath || !updatedPath || !outputPath) {
    console.error('Usage: node intake-historical-qa.mjs <meri-read-results.json> <updated-results.json> <output.json>');
    process.exitCode = 2;
    return;
  }
  const [rawReadBytes, rawUpdatedBytes] = await Promise.all([readFile(readPath), readFile(updatedPath)]);
  const inventory = buildHistoricalQaIntake(
    JSON.parse(rawReadBytes.toString('utf8')),
    JSON.parse(rawUpdatedBytes.toString('utf8')),
    rawReadBytes,
    rawUpdatedBytes,
  );
  await writeFile(path.resolve(outputPath), `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
  console.log(`Wrote hashed intake inventory: ${inventory.cohorts[0].recordCount} read QA rows; ${inventory.cohorts[1].recordCount} action-safety rows; no content/status fields.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
