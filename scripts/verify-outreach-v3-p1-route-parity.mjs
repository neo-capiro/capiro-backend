#!/usr/bin/env node
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

function union(files) {
  const routes = files.flatMap((file) => routeInventory(read(file)));
  const duplicates = routes.filter((route, index) => routes.indexOf(route) !== index);
  if (duplicates.length) throw new Error(`duplicate registered routes: ${[...new Set(duplicates)].join(', ')}`);
  return routes.sort();
}

export function parityProblems() {
  const problems = [];
  const pairs = [
    {
      name: 'microsoft',
      old: ['apps/api/src/engagement/microsoft/microsoft-oauth.controller.ts'],
      split: [
        'apps/api/src/engagement/microsoft/microsoft-integration-actions.controller.ts',
        'apps/api/src/engagement/microsoft/microsoft-callbacks.controller.ts',
      ],
    },
    {
      name: 'google',
      old: ['apps/api/src/engagement/google/google-oauth.controller.ts'],
      split: [
        'apps/api/src/engagement/google/google-integration-actions.controller.ts',
        'apps/api/src/engagement/google/google-callbacks.controller.ts',
      ],
    },
  ];
  for (const pair of pairs) {
    const before = union(pair.old);
    const after = union(pair.split);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      problems.push(
        `${pair.name} route inventory changed\nbefore=${JSON.stringify(before)}\nafter=${JSON.stringify(after)}`,
      );
    }
  }
  return problems;
}

function main() {
  const problems = parityProblems();
  if (problems.length) {
    for (const problem of problems) console.error(`FAIL  ${problem}`);
    process.exit(1);
  }
  console.log('OUTREACH_V3_P1_CALLBACK_ROUTE_PARITY_VALID');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
