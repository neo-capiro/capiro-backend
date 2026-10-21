#!/usr/bin/env node
/** @cleanup-smoke noArgsExit=0 */
/**
 * Phase 3 must prove the current UI through engagement-api without consuming
 * later Outreach V3 product/reasoning scope. Revised Outreach Phase 1 may add
 * backend foundations, contracts, documentation, and verification scripts; it
 * still may not add the final V3 UI, Campaign Spec, checkpoints, preflight, or
 * a LangGraph-owned runtime.
 */
import { execFileSync } from 'node:child_process';
import { resolvePhase3ScopeBase } from './engagement-phase3-scope-base.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { comparePaths, fingerprintOf, MEASURED_INPUTS } from '../apps/e2e/lib/source-identity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const END = process.env.ENGAGEMENT_PHASE3_SCOPE_END ?? 'HEAD';

export const FORBIDDEN_NEW_PATHS = [
  /^apps\/web\/.*(?:outreach(?:-|\/)v3|OutreachV3)/i,
  /(?:^|\/)CampaignSpec(?:\.|\/)/i,
  /(?:^|\/)campaign-spec(?:\.|\/)/i,
  /(?:^|\/)outreach-checkpoint/i,
  /(?:^|\/)representative-sample/i,
  /(?:^|\/)governed-context-selector/i,
  /(?:^|\/)outreach-preflight/i,
  /(?:^|\/)outreach-conversation-bar/i,
];

export const FORBIDDEN_ADDED_SOURCE = [
  /@langchain\/langgraph/i,
  /from\s+['"]@langchain\/core['"]/i,
  /<\s*OutreachV3\b/i,
  /\bOutreachV3(?:Page|Wizard|Route|Shell)\b/i,
  /\bCampaignSpec(?:Checkpoint|Repository|Service)\b/i,
];

function git(args) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

const BASELINE_SOURCE_INVENTORY = 'apps/e2e/baselines/source-manifest.json';

function baselineInventoryPaths(source) {
  const doc = JSON.parse(source);
  const keys = new Set(['schema', 'generatedAt', 'measuredInputs', 'fingerprint', 'fileCount',
    'totalBytes', 'sourceFingerprint', 'head', 'treeHash', 'files']);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) ||
    Object.keys(doc).some(key => !keys.has(key)) ||
    doc.schema !== 'capiro.cleanup1.visual-source-manifest.v1' ||
    typeof doc.generatedAt !== 'string' || !Number.isFinite(Date.parse(doc.generatedAt)) ||
    JSON.stringify(doc.measuredInputs) !== JSON.stringify([...MEASURED_INPUTS]) ||
    !Array.isArray(doc.files) || doc.files.length === 0 || doc.fileCount !== doc.files.length ||
    !Number.isSafeInteger(doc.totalBytes) || doc.totalBytes < 0 ||
    ![doc.head, doc.treeHash].every(value => value === null || /^[0-9a-f]{40}$/.test(value))) {
    throw new Error('metadata shape');
  }
  const paths = new Set();
  let previous = '';
  let totalBytes = 0;
  for (const file of doc.files) {
    if (!file || typeof file !== 'object' || Array.isArray(file) ||
      Object.keys(file).sort().join(',') !== 'bytes,path,sha256' ||
      typeof file.path !== 'string' || !file.path || file.path.startsWith('/') ||
      file.path.includes('\\') || /^[A-Za-z]:/.test(file.path) ||
      file.path.split('/').some(part => !part || part === '.' || part === '..') ||
      /[\x00-\x1f\x7f]/.test(file.path) || typeof file.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 ||
      paths.has(file.path) || comparePaths(previous, file.path) >= 0) {
      throw new Error('file record shape or order');
    }
    paths.add(file.path);
    previous = file.path;
    totalBytes += file.bytes;
  }
  if (totalBytes !== doc.totalBytes || fingerprintOf(doc.files) !== doc.fingerprint ||
    doc.sourceFingerprint !== doc.fingerprint) throw new Error('inventory fingerprint or byte total');
  return paths;
}

/** Inventory path records describe measured files; they are not source imports. */
export function sourceAdditionsForBoundary(diff, inventorySource) {
  const additions = [];
  const issues = [];
  let file = null;
  let inventoryPaths;
  let inHunk = false;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      file = null;
      inHunk = false;
    }
    if (!inHunk && line.startsWith('+++ ')) {
      file = line.startsWith('+++ b/') ? line.slice(6) : null;
      if (file === BASELINE_SOURCE_INVENTORY) {
        try {
          inventoryPaths = baselineInventoryPaths(inventorySource);
        } catch (error) {
          inventoryPaths = null;
          issues.push(`invalid baseline source inventory: ${error.message}`);
        }
      }
    } else if (line.startsWith('@@ ')) {
      inHunk = true;
    } else if (line.startsWith('+')) {
      const added = line.slice(1);
      if (file === BASELINE_SOURCE_INVENTORY && inventoryPaths) {
        const record = added.match(/^\s*"path":\s*("(?:\\.|[^"\\])*")\s*,?\s*$/);
        if (record && inventoryPaths.has(JSON.parse(record[1]))) continue;
      }
      additions.push(added);
    }
  }
  return { addedLines: additions.join('\n'), issues };
}

export function verifyBoundary({ changed = [], addedLines = '', deleted = [] }) {
  const issues = [];
  for (const file of changed) {
    for (const pattern of FORBIDDEN_NEW_PATHS) {
      if (pattern.test(file)) issues.push(`forbidden Phase 3 path: ${file}`);
    }
    if (
      /Outreach V3 \(standalone\)\.html$/i.test(file) ||
      /prototype.*\.(?:png|jpg|jpeg|svg|html)$/i.test(file)
    ) {
      issues.push(`prototype asset shipped in Phase 3: ${file}`);
    }
  }
  for (const pattern of FORBIDDEN_ADDED_SOURCE) {
    if (pattern.test(addedLines))
      issues.push(`forbidden Phase 3 source addition matches ${pattern}`);
  }
  for (const file of deleted) {
    if (/apps\/web\/src\/pages\/engagement\/(?:OutreachView\.tsx|outreach\/v2\/)/i.test(file)) {
      issues.push(`Outreach v2 removal is forbidden in Phase 3: ${file}`);
    }
  }
  return issues;
}

function main() {
  const BASE = resolvePhase3ScopeBase({
    git,
    end: END,
    explicitBase: process.env.ENGAGEMENT_PHASE3_BASE_SHA,
  });
  git(['cat-file', '-e', `${BASE}^{commit}`]);
  git(['cat-file', '-e', `${END}^{commit}`]);
  const range = `${BASE}..${END}`;
  const nameStatus = git(['diff', '--name-status', range])
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split(/\t+/));
  const changed = nameStatus.filter(([status]) => status !== 'D').map((parts) => parts.at(-1));
  const deleted = nameStatus.filter(([status]) => status === 'D').map((parts) => parts.at(-1));
  const diff = git([
    'diff',
    '--unified=0',
    range,
    '--',
    'apps',
    'packages',
    'package.json',
    'pnpm-lock.yaml',
  ]);
  const inventorySource = changed.includes(BASELINE_SOURCE_INVENTORY)
    ? git(['show', `${END}:${BASELINE_SOURCE_INVENTORY}`])
    : undefined;
  const additions = sourceAdditionsForBoundary(diff, inventorySource);
  const issues = [...additions.issues, ...verifyBoundary({ changed, addedLines: additions.addedLines, deleted })];
  const requiredCurrentFiles = [
    'apps/web/src/pages/engagement/OutreachView.tsx',
    'apps/web/src/pages/engagement/outreach/v2/NewOutreachWizard.tsx',
  ];
  for (const file of requiredCurrentFiles) {
    try {
      readFileSync(path.join(ROOT, file));
    } catch {
      issues.push(`required Outreach v2 source missing: ${file}`);
    }
  }

  if (issues.length) {
    for (const issue of issues) console.error(`FAIL  ${issue}`);
    throw new Error(`ENGAGEMENT_PHASE3_PROTOTYPE_BOUNDARY_FAILED (${issues.length})`);
  }
  console.log(`ENGAGEMENT_PHASE3_PROTOTYPE_BOUNDARY_COMPLETE changed=${changed.length}`);
}

if (
  import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` ||
  process.argv[1]?.endsWith('verify-engagement-phase3-prototype-boundary.mjs')
) {
  console.error('Usage: node scripts/verify-engagement-phase3-prototype-boundary.mjs (no arguments runs the existing verifier)');
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
