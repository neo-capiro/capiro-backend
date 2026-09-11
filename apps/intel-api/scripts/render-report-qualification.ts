import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  makeDocument,
  renderReport,
  settings,
  type ReportBill,
  type ReportAssignment,
} from '../src/tracker/reports/report-domain.js';

const output = resolve(process.argv[2] ?? 'work/report-samples');
mkdirSync(output, { recursive: true });
const now = new Date('2026-09-10T16:00:00Z');
const titles = [
  'Health services access',
  'Hospital workforce reporting',
  'Public health measures',
  'Community care coordination',
];
const bills: ReportBill[] = ['HB0093', 'SB0122', 'HB0289', 'SB0520'].map((number, i) => ({
  id: `synthetic-fl-2026-${number.toLowerCase()}`,
  number,
  title: titles[i]!,
  sponsor: 'Synthetic sponsor',
  jurisdiction: 'FL',
  sessionKey: '2026',
  status: 'In committee',
  sourceUrl: 'https://example.invalid/published-record',
  summary:
    'Synthetic source description used to qualify report layout and completeness. This is not a real legislative summary.',
  sourceCheckedAt: now.toISOString(),
  sourceCheckAttemptedAt: now.toISOString(),
  sourceCheckStatus: 'success',
  coverage: { actions: true, amendments: true, committees: true, relations: true },
  committees: [
    { id: 'committee-a', name: 'Health Committee', current: true, date: '2026-09-02' },
    { id: 'committee-b', name: 'Fiscal Committee', current: false, date: '2026-09-01' },
  ],
  relations: [],
  events: [0, 1, 2, 3].map((n) => ({
    key: `${i}:${n}`,
    kind: 'action' as const,
    sourceIdentity: `action-${i}-${n}`,
    revisionHash: 'synthetic-v1',
    date: i === 3 ? '2026-08-20' : `2026-09-${String(n + 6).padStart(2, '0')}`,
    text: ['Filed', 'Referred to Health Committee', 'Reported favorably', 'Placed on calendar'][n]!,
    order: n,
    observedAt: now.toISOString(),
    url: 'https://example.invalid/published-record',
  })),
}));
const definitions = [
  {
    id: '68654',
    name: 'Acadia',
    folder: 'Acadia Priority',
    committees: 'off',
    actions: 'five_days',
    relations: 'off',
    summary: true,
    order: 'last_action',
    links: 'subscribers',
  },
  {
    id: '68001',
    name: 'HCA',
    folder: 'EHC',
    committees: 'all',
    actions: 'last3',
    relations: 'title_action',
    summary: false,
    order: 'number',
    links: 'subscribers',
  },
  {
    id: '65835',
    name: 'HCA General',
    folder: 'HCA',
    committees: 'current',
    actions: 'last',
    relations: 'title',
    summary: true,
    order: 'number',
    links: 'public',
  },
  {
    id: '65291',
    name: 'MOLINA',
    folder: 'MOLINA',
    committees: 'all',
    actions: 'last',
    relations: 'off',
    summary: true,
    order: 'number',
    links: 'public',
  },
  {
    id: '67735',
    name: 'Tech Report',
    folder: 'GOOGLE',
    committees: 'current',
    actions: 'last3',
    relations: 'title',
    summary: true,
    order: 'last_action',
    links: 'subscribers',
  },
  {
    id: '67922',
    name: 'Tech Report',
    folder: 'GOOGLE',
    committees: 'current',
    actions: 'last',
    relations: 'title_action',
    summary: true,
    order: 'number',
    links: 'subscribers',
  },
];
for (const definition of definitions) {
  const assignments: ReportAssignment[] = bills.map((b) => ({
    id: `assignment-${definition.id}-${b.id}`,
    folderId: `synthetic-${definition.folder}`,
    folderName: definition.folder,
    folderVersion: 0,
    archived: false,
    billId: b.id,
    version: 0,
    topPriority: false,
    importance: 'normal',
    position: 'none',
    internalComments: 'Private fixture text must be excluded',
    externalComments: '',
  }));
  const doc = makeDocument({
    report: {
      id: definition.id,
      name: `${definition.name} — synthetic qualification`,
      version: 0,
      settings: settings(definition),
    },
    assignments,
    bills,
    cutoff: '2026-09-10',
    now,
    audience: 'external',
  });
  const rendered = renderReport(doc);
  if (!doc.complete || rendered.html.includes('Private fixture text'))
    throw new Error('Fixture qualification failed');
  writeFileSync(join(output, `${definition.id}.html`), rendered.html);
  writeFileSync(join(output, `${definition.id}.txt`), rendered.text);
  writeFileSync(join(output, `${definition.id}.json`), JSON.stringify(doc, null, 2));
}
console.log(JSON.stringify({ output, reports: definitions.length, synthetic: true }));
