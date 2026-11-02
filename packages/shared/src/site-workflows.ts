/** Browser-safe administration contract. Runtime host policy remains an independent ceiling. */
export const SITE_WORKFLOW_SCHEMA = 'meri-site-workflow-manifest/0' as const;
export const SITE_WORKFLOW_TOOLS = ['browser_navigate', 'browser_navigate_back', 'browser_snapshot',
  'browser_click', 'browser_type', 'browser_fill_form', 'browser_select_option', 'browser_press_key',
  'browser_hover', 'browser_wait_for', 'browser_take_screenshot', 'browser_tabs',
  'browser_handle_dialog', 'browser_close'] as const;
export const SITE_WORKFLOW_INTERACTIONS = ['browser_click', 'browser_type', 'browser_fill_form',
  'browser_select_option', 'browser_press_key', 'browser_hover', 'browser_handle_dialog'] as const;
export const SITE_WORKFLOW_FORMATS = ['docx', 'txt', 'xlsx', 'pptx', 'pdf', 'zip'] as const;
export type SiteWorkflowTool = typeof SITE_WORKFLOW_TOOLS[number];
export interface SiteWorkflowManifest {
  schema: typeof SITE_WORKFLOW_SCHEMA; siteId: string; workflowId: string; version: number;
  taskSummary: string; origins: string[]; idpOrigins: string[]; signInUrl: string;
  signedInProbe: { kind: 'url' | 'selector'; value: string }; sensitiveSelectors: string[];
  tools: SiteWorkflowTool[]; approvalRequired: SiteWorkflowTool[];
  downloads: { formats: Array<typeof SITE_WORKFLOW_FORMATS[number]>; maxBytes: number; maxFiles: number };
  sessionTtlMs: number; logoutUrl: string | null; tosReviewRef: string | null; qualificationEvidenceRef: string | null;
}
export interface SiteWorkflowSelection { siteId: string; workflowId: string; version: number; manifestSha256: string }
export interface SiteWorkflowConfiguration { manifest: SiteWorkflowManifest; manifestSha256: string; enabled: boolean }
export interface SaveSiteWorkflowInput {
  requestId: string; expectedVersion: number; manifest: SiteWorkflowManifest; enabled: boolean;
}
export interface SiteWorkflowReceipt {
  requestId: string; configuration: SiteWorkflowConfiguration; savedAt: string;
}
export const SITE_WORKFLOW_SLUG = /^[a-z][a-z0-9-]{1,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const REF = /^[A-Za-z0-9._/:#-]{1,200}$/;
const fields = ['schema', 'siteId', 'workflowId', 'version', 'taskSummary', 'origins', 'idpOrigins',
  'signInUrl', 'signedInProbe', 'sensitiveSelectors', 'tools', 'approvalRequired', 'downloads',
  'sessionTtlMs', 'logoutUrl', 'tosReviewRef', 'qualificationEvidenceRef'];
export function siteWorkflowObject(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(raw)) ||
      Object.keys(raw).sort().join() !== [...keys].sort().join()) throw Error('SITE_WORKFLOW_INPUT');
  return raw as Record<string, unknown>;
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max &&
    !/[\u0000-\u001f\u007f]/.test(value);
}
function integer(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
}
function list(value: unknown, max: number): value is unknown[] {
  return Array.isArray(value) && value.length <= max && new Set(value).size === value.length &&
    Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)).every(Boolean);
}
/** Configuration admits HTTPS DNS origins. Host egress/DNS and platform ceilings are checked at execution. */
function publicUrl(value: unknown): URL {
  if (!text(value, 2048) || /\s/.test(value)) throw Error('SITE_WORKFLOW_URL');
  const url = new URL(value), host = url.hostname, labels = host.split('.');
  if (url.protocol !== 'https:' || url.username || url.password || labels.length < 2 ||
      !labels.every(part => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(part)) ||
      !/^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(labels.at(-1)!) ||
      ['localhost','local','localdomain','internal','intranet','private','corp','home','lan','arpa','test','invalid','onion','alt']
        .some(suffix => host === suffix || host.endsWith('.' + suffix))) throw Error('SITE_WORKFLOW_URL');
  return url;
}
function origins(raw: unknown, allowEmpty: boolean): string[] {
  if (!list(raw, 32) || (!allowEmpty && !raw.length)) throw Error('SITE_WORKFLOW_ORIGINS');
  for (const value of raw) if (publicUrl(value).origin !== value) throw Error('SITE_WORKFLOW_ORIGINS');
  return raw as string[];
}
function reachable(raw: unknown, allowed: string[]) {
  if (!allowed.includes(publicUrl(raw).origin)) throw Error('SITE_WORKFLOW_URL');
}
export function parseSiteWorkflowManifest(raw: unknown): SiteWorkflowManifest {
  const m = siteWorkflowObject(raw, fields);
  if (m.schema !== SITE_WORKFLOW_SCHEMA || typeof m.siteId !== 'string' || !SITE_WORKFLOW_SLUG.test(m.siteId) ||
      typeof m.workflowId !== 'string' || !SITE_WORKFLOW_SLUG.test(m.workflowId) ||
      !integer(m.version, 1, 2147483647) || !text(m.taskSummary, 500)) throw Error('SITE_WORKFLOW_IDENTITY');
  const allowed = origins(m.origins, false), idp = origins(m.idpOrigins, true);
  reachable(m.signInUrl, [...allowed, ...idp]);
  const probe = siteWorkflowObject(m.signedInProbe, ['kind', 'value']);
  if (!['url', 'selector'].includes(String(probe.kind)) || !text(probe.value, 512)) throw Error('SITE_WORKFLOW_PROBE');
  if (probe.kind === 'url') reachable(probe.value, allowed);
  if (!list(m.sensitiveSelectors, 64) || m.sensitiveSelectors.some(value => !text(value, 256))) throw Error('SITE_WORKFLOW_SELECTORS');
  if (!list(m.tools, SITE_WORKFLOW_TOOLS.length) || !m.tools.length ||
      m.tools.some(tool => !SITE_WORKFLOW_TOOLS.includes(tool as SiteWorkflowTool))) throw Error('SITE_WORKFLOW_TOOLS');
  const interactions = m.tools.filter(tool => (SITE_WORKFLOW_INTERACTIONS as readonly unknown[]).includes(tool));
  if (!list(m.approvalRequired, interactions.length) || m.approvalRequired.length !== interactions.length ||
      m.approvalRequired.some(tool => !interactions.includes(tool))) throw Error('SITE_WORKFLOW_PREAPPROVAL_REFUSED');
  const d = siteWorkflowObject(m.downloads, ['formats', 'maxBytes', 'maxFiles']);
  if (!list(d.formats, SITE_WORKFLOW_FORMATS.length) ||
      d.formats.some(format => !(SITE_WORKFLOW_FORMATS as readonly unknown[]).includes(format)) ||
      !integer(d.maxBytes, 1, 26214400) || !integer(d.maxFiles, 0, 50)) throw Error('SITE_WORKFLOW_DOWNLOADS');
  if (!integer(m.sessionTtlMs, 60000, 28800000)) throw Error('SITE_WORKFLOW_RETENTION');
  if (m.logoutUrl !== null) reachable(m.logoutUrl, [...allowed, ...idp]);
  for (const name of ['tosReviewRef', 'qualificationEvidenceRef'])
    if (m[name] !== null && (typeof m[name] !== 'string' || !REF.test(m[name]))) throw Error('SITE_WORKFLOW_EVIDENCE');
  const copied = { ...m, origins: [...allowed], idpOrigins: [...idp], signedInProbe: { kind: probe.kind, value: probe.value },
    sensitiveSelectors: [...m.sensitiveSelectors], tools: [...m.tools], approvalRequired: [...m.approvalRequired],
    downloads: { formats: [...d.formats], maxBytes: d.maxBytes, maxFiles: d.maxFiles } };
  return Object.fromEntries(fields.map(key => [key, copied[key as keyof typeof copied]])) as unknown as SiteWorkflowManifest;
}
export function parseSiteWorkflowSelection(raw: unknown): SiteWorkflowSelection {
  const v = siteWorkflowObject(raw, ['siteId', 'workflowId', 'version', 'manifestSha256']);
  if (typeof v.siteId !== 'string' || !SITE_WORKFLOW_SLUG.test(v.siteId) ||
      typeof v.workflowId !== 'string' || !SITE_WORKFLOW_SLUG.test(v.workflowId) ||
      !integer(v.version, 1, 2147483647) || typeof v.manifestSha256 !== 'string' || !HASH.test(v.manifestSha256))
    throw Error('SITE_WORKFLOW_SELECTION');
  return v as unknown as SiteWorkflowSelection;
}
export function parseSaveSiteWorkflow(raw: unknown): SaveSiteWorkflowInput {
  const v = siteWorkflowObject(raw, ['requestId', 'expectedVersion', 'manifest', 'enabled']);
  if (typeof v.requestId !== 'string' || !UUID.test(v.requestId) || !integer(v.expectedVersion, 0, 2147483646) ||
      typeof v.enabled !== 'boolean') throw Error('SITE_WORKFLOW_SAVE');
  const manifest = parseSiteWorkflowManifest(v.manifest);
  if (manifest.version !== Number(v.expectedVersion) + 1) throw Error('SITE_WORKFLOW_VERSION');
  if (v.enabled && (!manifest.tosReviewRef || !manifest.qualificationEvidenceRef)) throw Error('SITE_WORKFLOW_EVIDENCE_REQUIRED');
  return { requestId: v.requestId, expectedVersion: v.expectedVersion as number, enabled: v.enabled, manifest };
}
export function parseSiteWorkflowConversationId(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw Error('SITE_WORKFLOW_CONVERSATION');
  return value;
}

