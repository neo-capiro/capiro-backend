#!/usr/bin/env node
/** @cleanup-smoke noArgsExit=0 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function routeInventory(source) {
  const controller = source.match(/@Controller\(\s*['"`]([^'"`]+)['"`]\s*\)/)?.[1];
  if (!controller) throw new Error('controller prefix not found');
  const routes = [];
  const pattern = /@(Get|Post|Put|Patch|Delete)\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const method = match[1].toUpperCase();
    const suffix = match[2] ?? '';
    routes.push(`${method} /${[controller, suffix].filter(Boolean).join('/')}`);
  }
  return routes.sort();
}

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function union(files, readSource) {
  const routes = files.flatMap((file) => routeInventory(readSource(file)));
  const duplicates = routes.filter((route, index) => routes.indexOf(route) !== index);
  if (duplicates.length) throw new Error(`duplicate registered routes: ${[...new Set(duplicates)].join(', ')}`);
  return routes.sort();
}

/** Retained public method/path contract; deleted implementation copies are not a test oracle. */
export function parityProblems(readSource = read) {
  const problems = [];
  const common = ['GET capabilities', 'DELETE :connectionId', 'POST start', 'POST :connectionId/sync', 'GET callback'];
  for (const provider of ['microsoft', 'google']) {
    const suffixes = provider === 'microsoft'
      ? [...common, 'POST :connectionId/calendar-window', 'POST :connectionId/subscriptions', 'GET notifications', 'POST notifications']
      : common;
    const expected = suffixes.map((entry) => {
      const [method, suffix] = entry.split(' ');
      return `${method} /engagement/integrations/${provider}/${suffix}`;
    }).sort();
    const actual = union([
      `apps/api/src/engagement/${provider}/${provider}-integration-actions.controller.ts`,
      `apps/api/src/engagement/${provider}/${provider}-callbacks.controller.ts`,
    ], readSource);
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      problems.push(`${provider} route inventory changed\nexpected=${JSON.stringify(expected)}\nactual=${JSON.stringify(actual)}`);
    }
  }
  return problems;
}

function main() {
  console.error('Usage: node scripts/verify-outreach-v3-p1-route-parity.mjs (no arguments runs the existing verifier)');
  const problems = parityProblems();
  if (problems.length) {
    for (const problem of problems) console.error(`FAIL  ${problem}`);
    process.exit(1);
  }
  console.log('OUTREACH_V3_P1_CALLBACK_ROUTE_PARITY_VALID');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
