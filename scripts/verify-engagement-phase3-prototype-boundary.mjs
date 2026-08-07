#!/usr/bin/env node
/**
 * Phase 3 must prove the current UI through engagement-api without consuming
 * Phase 4 or Outreach V3 scope. This verifier evaluates the actual Phase 3 git
 * diff rather than scanning all historical source for words that legitimately
 * predate this phase.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.ENGAGEMENT_PHASE3_BASE_SHA ?? '3841a5ee58e011be7fb4fb6008adfccf081976d9';

export const FORBIDDEN_NEW_PATHS = [
  /(?:^|\/)outreach(?:-|\/)v3(?:\/|\.|$)/i,
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
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

export function verifyBoundary({ changed = [], addedLines = '', deleted = [] }) {
  const issues = [];
  for (const file of changed) {
    for (const pattern of FORBIDDEN_NEW_PATHS) {
      if (pattern.test(file)) issues.push(`forbidden Phase 3 path: ${file}`);
    }
    if (/Outreach V3 \(standalone\)\.html$/i.test(file) || /prototype.*\.(?:png|jpg|jpeg|svg|html)$/i.test(file)) {
      issues.push(`prototype asset shipped in Phase 3: ${file}`);
    }
  }
  for (const pattern of FORBIDDEN_ADDED_SOURCE) {
    if (pattern.test(addedLines)) issues.push(`forbidden Phase 3 source addition matches ${pattern}`);
  }
  for (const file of deleted) {
    if (/apps\/web\/src\/pages\/engagement\/(?:OutreachView\.tsx|outreach\/v2\/)/i.test(file)) {
      issues.push(`Outreach v2 removal is forbidden in Phase 3: ${file}`);
    }
  }
  return issues;
}

function main() {
  git(['cat-file', '-e', `${BASE}^{commit}`]);
  const nameStatus = git(['diff', '--name-status', `${BASE}..HEAD`])
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split(/\t+/));
  const changed = nameStatus.filter(([status]) => status !== 'D').map((parts) => parts.at(-1));
  const deleted = nameStatus.filter(([status]) => status === 'D').map((parts) => parts.at(-1));
  const diff = git(['diff', '--unified=0', `${BASE}..HEAD`, '--', 'apps', 'packages', 'package.json', 'pnpm-lock.yaml']);
  const addedLines = diff
    .split(/\r?\n/)
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n');

  const issues = verifyBoundary({ changed, addedLines, deleted });
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

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('verify-engagement-phase3-prototype-boundary.mjs')) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
