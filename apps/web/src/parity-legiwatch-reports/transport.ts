const defaultSettings = {
  committees: 'off',
  actions: 'last',
  relations: 'off',
  summary: true,
  order: 'number',
  links: 'subscribers',
  priority: false,
  internalComments: false,
  externalComments: false,
  billNotes: false,
  reportComments: false,
  priorityOnly: false,
  acceptOptionalGaps: false,
  includeArchived: false,
};
const definitions = [
  ['68654', 'Acadia', 'Acadia Priority', 'off', 'five_days', 'off', true, 'last_action'],
  ['68001', 'HCA', 'EHC', 'all', 'last3', 'title_action', false, 'number'],
  ['65835', 'HCA General', 'HCA', 'current', 'last', 'title', true, 'number'],
  ['65291', 'MOLINA', 'MOLINA', 'all', 'last', 'off', true, 'number'],
  ['67735', 'Tech Report', 'GOOGLE', 'current', 'last3', 'title', true, 'last_action'],
  ['67922', 'Tech Report', 'GOOGLE', 'current', 'last', 'title_action', true, 'number'],
];
const folders = definitions.map((d, i) => ({
  id: `folder-${i}`,
  name: d[2],
  jurisdiction: 'FL',
  defaultSession: '2026',
  version: 1,
  canEdit: true,
}));
const reports = definitions.map((d, i) => ({
  id: `report-${i}`,
  sourceId: d[0],
  name: d[1],
  folderIds: [folders[i]!.id],
  jurisdiction: 'FL',
  sessionKey: '2026',
  version: 3,
  canEdit: true,
  settings: {
    ...defaultSettings,
    committees: d[3],
    actions: d[4],
    relations: d[5],
    summary: d[6],
    order: d[7],
    links: i === 2 || i === 3 ? 'public' : 'subscribers',
  },
}));
const directory = {
  senderEmail: 'operator@example.invalid',
  contacts: [
    {
      id: 'contact-a',
      name: 'Synthetic client recipient',
      email: 'client@example.invalid',
      verified: true,
      active: true,
      optedOut: false,
      version: 1,
    },
    {
      id: 'contact-b',
      name: 'Synthetic alias',
      email: 'client@example.invalid',
      verified: false,
      active: true,
      optedOut: false,
      version: 1,
    },
  ],
  lists: [
    {
      id: 'list-a',
      name: 'Reviewed test list',
      private: true,
      active: true,
      version: 1,
      contactIds: ['contact-a'],
    },
    {
      id: 'list-empty',
      name: 'Empty list example',
      private: false,
      active: true,
      version: 1,
      contactIds: [],
    },
  ],
};
const subscription = {
  id: 'sub-a',
  reportId: reports[0]!.id,
  name: 'Acadia daily review',
  mode: 'draft',
  enabled: false,
  version: 1,
  timezone: 'America/New_York',
  localMinutes: 480,
  recipients: [],
  baselineAt: null,
  catchUp: 'draft',
  subject: 'Daily legislative update',
  introduction: '',
  sendNoChange: false,
};
let run: Record<string, unknown> | null = null;
let rules = Array.from({ length: 11 }, (_, i) => ({
  id: `rule-${i}`,
  name: i === 0 ? 'Empty captured targets' : `Published record rule ${i + 1}`,
  folderIds: i === 0 ? [] : [folders[i % 6]!.id],
  recipients: [{ userId: 'staff-a', email: true, inApp: true }],
  cadence: i === 1 || i === 5 ? 'end_of_day' : 'realtime',
  state: 'needs_review',
  version: 1,
  timezone: 'America/New_York',
  localMinutes: 1020,
  issues: i === 0 ? ['No folder targets selected'] : [],
}));
export const useApiScope = () => 'synthetic-legiwatch-phase2';
const data = <T>(value: unknown) => ({ data: value as T });
export function useApi() {
  return {
    async get<T>(url: string) {
      if (url.endsWith('/feature-flags'))
        return data<T>({ legiwatch_reports_updates_v1: true, legiwatch_report_delivery_v1: true });
      if (url.endsWith('/recipients')) return data<T>(directory);
      if (url.endsWith('/members'))
        return data<T>({
          members: [{ id: 'staff-a', name: 'Synthetic staff', email: 'operator@example.invalid' }],
        });
      if (url.endsWith('/folders')) return data<T>(folders);
      if (url.endsWith('/sessions/FL')) return data<T>([{ key: '2026', label: '2026 session' }]);
      if (url.endsWith('/reports')) return data<T>(reports);
      if (url.endsWith('/subscriptions')) return data<T>([subscription]);
      if (url.endsWith('/rules')) return data<T>(rules);
      if (url.endsWith('/readiness'))
        return data<T>({
          ready: false,
          issues: ['Review current source coverage before activation'],
          examples: [
            {
              key: 'action-a',
              number: 'HB0093',
              text: 'Referred to committee',
              date: '2026-09-10',
              kind: 'action',
            },
          ],
        });
      if (url.endsWith('/history'))
        return data<T>(url.includes('/subscriptions/') ? [] : run ? [run] : []);
      if (url.includes('/runs/')) return data<T>(url.endsWith('/deliveries') ? [] : run);
      return data<T>([]);
    },
    async post<T>(url: string, body: any) {
      if (url.endsWith('/generate')) {
        const report = reports.find((r) => url.includes(`/${r.id}/`))!;
        run = {
          id: 'run-a',
          reportId: report.id,
          audience: body.audience,
          definitionVersion: report.version,
          cutoff: body.cutoff,
          generatedAt: new Date().toISOString(),
          complete: true,
          contentHash: 'synthetic-content-hash',
          rendered: {
            html: '<!doctype html><html><body style="font:16px Georgia;padding:32px;line-height:1.6"><h1>Acadia</h1><p>Florida · 2026 · Synthetic qualification sample</p><hr><h2>HB0093 — Health services</h2><p>Source description · Synthetic legislative record for interface testing.</p><p><strong>September 10</strong> · Referred to committee</p><h2>SB0122 — Public health reporting</h2><p>No actions in the selected display window. This tracked bill remains in the report.</p></body></html>',
            text: 'Synthetic qualification report',
          },
        };
        return data<T>(run);
      }
      if (url.endsWith('/compose'))
        return data<T>({
          complete: true,
          approvalHash: 'synthetic-review',
          composition: {
            subject: body.subject,
            introduction: body.introduction,
            recipients: body.selection.flatMap((s: any) =>
              s.kind === 'manual'
                ? [{ email: s.email, role: s.role, contacts: [], lists: [] }]
                : [{ email: 'client@example.invalid', role: s.role, contacts: [], lists: [] }],
            ),
          },
        });
      if (url.endsWith('/send')) throw new Error('Synthetic harness cannot deliver messages');
      return data<T>({ ...subscription, ...body, enabled: false });
    },
    async put<T>(url: string, body: any) {
      const report = reports.find((r) => url.endsWith(`/${r.id}`));
      if (report) Object.assign(report, body, { version: report.version + 1 });
      return data<T>(report ?? body);
    },
  };
}
