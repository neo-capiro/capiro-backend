import * as fs from 'node:fs';
import { cleanOrgName, isCleanOffice, classifyOfficeType } from '../../src/acquisition-personnel/org-import/dow-org-import.helpers.js';
const people = JSON.parse(fs.readFileSync('scripts/__data__/dow_directory_v6/dow_v6_people.json', 'utf8')) as Array<{organization?: string|null; sub_organization?: string|null}>;
const counts = new Map<string, number>();
for (const p of people) {
  for (const raw of [p.organization, p.sub_organization]) {
    const n = cleanOrgName(raw ?? '');
    if (n) counts.set(n, (counts.get(n) ?? 0) + 1);
  }
}
const accepted: Array<[string, number]> = [];
const rejected: Array<[string, number]> = [];
for (const [name, n] of counts) (isCleanOffice(name, n) ? accepted : rejected).push([name, n]);
accepted.sort((a, b) => b[1] - a[1]); rejected.sort((a, b) => b[1] - a[1]);
const strip = (s: string) => s.replace(/[^\x20-\x7E]/g, '#');
console.log(`total distinct: ${counts.size}  accepted: ${accepted.length}  rejected: ${rejected.length}`);
console.log('\n--- TOP 35 ACCEPTED ---');
for (const [n, c] of accepted.slice(0, 35)) console.log(`  ${String(c).padStart(4)}  [${classifyOfficeType(n)}] ${strip(n).slice(0, 78)}`);
console.log('\n--- TOP 35 REJECTED ---');
for (const [n, c] of rejected.slice(0, 35)) console.log(`  ${String(c).padStart(4)}  ${strip(n).slice(0, 78)}`);
console.log('\n--- ACCEPTED TAIL (weakest 25) ---');
for (const [n, c] of accepted.slice(-25)) console.log(`  ${String(c).padStart(4)}  [${classifyOfficeType(n)}] ${strip(n).slice(0, 78)}`);
