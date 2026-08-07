#!/usr/bin/env node
/**
 * Phase 3 micro-session 3.1 — current Engagement UI surface and API consumer
 * inventory.
 *
 * Builds the authoritative list of everything Phase 3 must prove parity for by
 * statically scanning the CURRENT web source. Nothing here is hand-maintained
 * except the two review tables at the top (SURFACES, CLASSIFICATION_RULES) —
 * the request list itself is derived, so a new consumer added to the product
 * cannot silently escape the parity workload.
 *
 * The scan is lexical, not a full TypeScript parse. That is a deliberate
 * trade: every call site in this repo reaches the API through the shared axios
 * instance with a string or template-literal first argument, and a lexical scan
 * that FAILS CLOSED on anything it cannot resolve is more trustworthy here than
 * a parser that silently resolves the wrong thing. Unresolvable dynamic URLs
 * are reported as findings, never dropped.
 *
 * Usage:
 *   node scripts/engagement-phase3-ui-inventory.mjs --check <manifest.json>
 *   node scripts/engagement-phase3-ui-inventory.mjs --write <manifest.json>
 *
 * Exit: 0 manifest is current and every invariant holds · 1 otherwise
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_SRC = path.join(ROOT, 'apps/web/src');
const ROUTE_MANIFEST_PATH = path.join(
  ROOT,
  'apps/api/src/engagement/__fixtures__/engagement-route-manifest.v1.json',
);

export const SCHEMA_VERSION = 1;
const ENGAGEMENT_PREFIX = '/api/engagement';

// ─────────────────────────────────────────────────────────────────── surfaces
//
// The reviewed surface table. Every consumer file that talks to
// /api/engagement/* MUST map to exactly one surface here; an unmapped consumer
// is a hard failure, which is what forces this table to stay honest when the
// product grows a new Engagement caller.
//
// `owner` distinguishes the surfaces the Engagement tabs own from the
// cross-surface consumers that merely read Engagement data while living
// elsewhere in the product. Phase 3 must prove parity for both, but only the
// former change their SPA route.

export const SURFACES = [
  {
    id: 'engagement-shell',
    title: 'Engagement page shell and Meetings',
    owner: 'engagement',
    spaRoutes: ['/engagement', '/engagement/overview', '/engagement/meetings'],
    files: ['apps/web/src/pages/engagement/EngagementPage.tsx'],
  },
  {
    id: 'engagement-meetings-api',
    title: 'Meetings data layer',
    owner: 'engagement',
    spaRoutes: ['/engagement/meetings'],
    files: ['apps/web/src/pages/engagement/meetings/meetings-api.ts'],
  },
  {
    id: 'engagement-outreach-list',
    title: 'Outreach v2 list and record shell',
    owner: 'engagement',
    spaRoutes: ['/engagement/outreach'],
    files: ['apps/web/src/pages/engagement/OutreachView.tsx'],
  },
  {
    id: 'engagement-outreach-wizard',
    title: 'Outreach v2 wizard steps',
    owner: 'engagement',
    spaRoutes: ['/engagement/outreach'],
    files: [
      'apps/web/src/pages/engagement/outreach/v2/NewOutreachWizard.tsx',
      'apps/web/src/pages/engagement/outreach/v2/StepContext.tsx',
      'apps/web/src/pages/engagement/outreach/v2/StepRecipientsSelect.tsx',
      'apps/web/src/pages/engagement/outreach/v2/groups.tsx',
      'apps/web/src/pages/engagement/outreach/v2/jobs.ts',
      'apps/web/src/pages/engagement/outreach/v2/priorContact.ts',
      'apps/web/src/pages/engagement/outreach/v2/send-intent.ts',
    ],
  },
  {
    id: 'settings-integrations',
    title: 'Integrations settings',
    owner: 'engagement',
    spaRoutes: ['/settings/integrations'],
    files: ['apps/web/src/pages/settings/IntegrationsPage.tsx'],
  },
  {
    id: 'app-shell',
    title: 'Application shell connection banner',
    owner: 'cross-surface',
    spaRoutes: ['*'],
    files: ['apps/web/src/components/AppShell.tsx'],
  },
  {
    id: 'onboarding',
    title: 'Onboarding integration gates',
    owner: 'cross-surface',
    spaRoutes: ['/onboarding'],
    files: ['apps/web/src/components/onboarding/OnboardingGates.tsx'],
  },
  {
    id: 'home-dashboard',
    title: 'Home dashboard meetings and outreach',
    owner: 'cross-surface',
    spaRoutes: ['/'],
    files: ['apps/web/src/pages/HomePage.tsx'],
  },
  {
    id: 'client-profile',
    title: 'Client profile attachments and engagement widgets',
    owner: 'cross-surface',
    spaRoutes: ['/clients/:clientId'],
    files: [
      'apps/web/src/pages/clients/ClientProfilePage.tsx',
      'apps/web/src/pages/clients/CapabilityDrawer.tsx',
      'apps/web/src/pages/clients/ClientWorkspacePage.tsx',
      'apps/web/src/pages/clients/tracker/TrackerFeedPanel.tsx',
      'apps/web/src/pages/clients/intelligence-v1/sections/SnapshotSection.tsx',
    ],
  },
  {
    id: 'admin-clients',
    title: 'Admin clients attachment upload',
    owner: 'cross-surface',
    spaRoutes: ['/admin/clients'],
    files: ['apps/web/src/pages/admin/ClientsPage.tsx'],
  },
  {
    id: 'workspace-context',
    title: 'Workspace context builder',
    owner: 'cross-surface',
    spaRoutes: ['/workspace'],
    files: ['apps/web/src/pages/workspace/ContextBuilderPage.tsx'],
  },
  {
    id: 'program-element',
    title: 'Program element contacts',
    owner: 'cross-surface',
    spaRoutes: ['/program-elements/:id'],
    files: ['apps/web/src/pages/program-element/api.ts'],
  },
  {
    id: 'funding-opportunities',
    title: 'Funding opportunities engagement link',
    owner: 'cross-surface',
    spaRoutes: ['/intelligence/opportunities'],
    files: ['apps/web/src/pages/intelligence/opportunities/FundingOpportunitiesPage.tsx'],
  },
];

// ────────────────────────────────────────────────── authoritative external set
//
// Classification is NOT guessed from the URL. The server already carries the
// answer: Phase 1 marks every externally-effecting handler with
// `@EngagementRuntimeAction('<action>')`, and that decorator is exactly what
// engagement-api consults to refuse the call in shadow mode. Deriving the
// inventory from the same metadata means the manifest cannot disagree with the
// runtime it is supposed to describe.
//
// Path heuristics survive below only as a CROSS-CHECK: if a route looks
// external but carries no decorator, that is a server-side hole worth failing
// on, not something for the inventory to quietly paper over.

const RUNTIME_ACTION_DECORATOR = /@EngagementRuntimeAction\(\s*'([a-z_]+)'/;

/** Map of `<sourceFile>#<handler>` to the declared external action. */
export function collectRuntimeActions(root = ROOT) {
  const actions = new Map();
  const files = execFileList(root);

  for (const rel of files) {
    const lines = readFileSync(path.join(root, rel), 'utf8').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const match = RUNTIME_ACTION_DECORATOR.exec(lines[i]);
      if (!match) continue;
      // Walk forward past any further decorators to the method declaration.
      for (let j = i + 1; j < Math.min(lines.length, i + 12); j += 1) {
        const line = lines[j].trim();
        if (line === '' || line.startsWith('@') || line.startsWith('//') || line.startsWith('*')) {
          continue;
        }
        const handler = /^(?:public\s+|private\s+|protected\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/.exec(line);
        if (handler) actions.set(`${rel}#${handler[1]}`, match[1]);
        break;
      }
    }
  }
  return actions;
}

function execFileList(root) {
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current).sort()) {
      const full = path.join(current, entry);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (SKIP_DIR.test(rel)) continue;
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith('.ts') || SKIP_FILE.test(entry)) continue;
      out.push(rel);
    }
  };
  walk(path.join(root, 'apps/api/src/engagement'));
  return out;
}

// ────────────────────────────────────────────────────── heuristic cross-check
//
// Ordered, first-match-wins. Each rule is a reviewed decision about whether a
// request may run in the dark preview.
//
//   read              — no writes; always safe in preview
//   safe_local_write  — writes only rows in the shared Aurora database; safe in
//                       preview because both runtimes share one database and no
//                       external system is touched
//   external_action   — reaches a provider, an LLM, a job queue, a send intent,
//                       an OAuth mutation, a notetaker bot, or object storage.
//                       MUST be denied by engagement-api in shadow mode with
//                       ENGAGEMENT_EXTERNAL_ACTION_DISABLED.
//
// The `why` text is not decoration: 3.14 re-reviews these decisions, and a rule
// nobody can justify is a finding.

export const CLASSIFICATION_RULES = [
  // ── reads that sit under an otherwise-external path ────────────────────────
  //
  // These must come FIRST. Every rule below is path-only and first-match-wins,
  // so a GET that reads the status of a send intent would otherwise be swallowed
  // by the `/send(-|$)/` send rule and reported as an undeclared external action.
  {
    method: 'GET',
    match: /\/send-intents?(\/|$)/,
    classification: 'read',
    why: 'send-intent status read; no provider contact',
  },

  // ── external: AI generation ────────────────────────────────────────────────
  { match: /\/generate(-|$)/, classification: 'external_action', why: 'LLM generation call' },
  { match: /\/debrief-draft$/, classification: 'external_action', why: 'LLM debrief drafting' },
  {
    match: /\/meetings\/[^/]+\/prep$/,
    method: 'POST',
    classification: 'external_action',
    why: 'LLM meeting-prep generation',
  },
  { match: /\/ai-fill$/, classification: 'external_action', why: 'LLM field fill' },
  { match: /\/ai-enhance$/, classification: 'external_action', why: 'LLM text enhancement' },

  // ── external: sending ──────────────────────────────────────────────────────
  // `/send(-|$)/`, not `/send$/`. An end-anchored pattern matches `/send` and
  // `/send-campaign` but silently misses `/outreach/send-batch` — a real send
  // route. The cross-check is only worth having if it catches that one.
  { match: /\/send(-|$)/, classification: 'external_action', why: 'provider email send' },
  { match: /\/test-send$/, classification: 'external_action', why: 'provider test send' },
  { match: /\/send-intents?(\/|$)/, classification: 'external_action', why: 'durable send intent' },
  { match: /\/open-email$/, classification: 'external_action', why: 'provider-backed compose URL' },

  // ── external: notetaker ────────────────────────────────────────────────────
  { match: /\/notetaker$/, method: 'POST', classification: 'external_action', why: 'Recall bot dispatch' },
  { match: /\/notetaker$/, method: 'DELETE', classification: 'external_action', why: 'Recall bot removal' },

  // ── external: attachments and object storage ───────────────────────────────
  { match: /\/attachments\/upload-url$/, classification: 'external_action', why: 'S3 presigned upload' },
  { match: /\/attachments\/confirm$/, classification: 'external_action', why: 'S3 object finalization' },
  { match: /\/extract-text$/, classification: 'external_action', why: 'text extraction pipeline' },
  { match: /\/attachments\/[^/]+\/download/, classification: 'external_action', why: 'S3 presigned download' },

  // ── external: integrations and OAuth ───────────────────────────────────────
  { match: /\/integrations\/[^/]+\/start$/, classification: 'external_action', why: 'OAuth authorize start' },
  { match: /\/integrations\/[^/]+\/callback/, classification: 'external_action', why: 'OAuth callback' },
  { match: /\/integrations\/.*\/sync$/, classification: 'external_action', why: 'provider mailbox/calendar sync' },
  { match: /\/integrations\/.*\/subscriptions?(\/|$)/, classification: 'external_action', why: 'provider subscription' },
  {
    match: /\/integrations\/[^/]+\/[^/]+$/,
    method: 'DELETE',
    classification: 'external_action',
    why: 'provider disconnect revokes a live token',
  },

  // ── safe local writes ──────────────────────────────────────────────────────
  { method: 'POST', classification: 'safe_local_write', why: 'database-local create' },
  { method: 'PUT', classification: 'safe_local_write', why: 'database-local replace' },
  { method: 'PATCH', classification: 'safe_local_write', why: 'database-local update' },
  { method: 'DELETE', classification: 'safe_local_write', why: 'database-local delete' },

  // ── reads ──────────────────────────────────────────────────────────────────
  { method: 'GET', classification: 'read', why: 'read-only' },
];

/** The heuristic opinion — used only to detect an undecorated external route. */
export function heuristicClassify(method, routePath) {
  for (const rule of CLASSIFICATION_RULES) {
    if (rule.method && rule.method !== method) continue;
    if (rule.match && !rule.match.test(routePath)) continue;
    return { classification: rule.classification, why: rule.why };
  }
  return { classification: 'unclassified', why: 'no rule matched' };
}

/** The authoritative classification: decorator first, then method. */
/**
 * Routes the heuristics flag as external that provably are not, each with the
 * evidence that settled it. This list exists so the cross-check can stay strict
 * by default: an exemption costs a source citation, so the cheap way out is to
 * fix the code, not to widen a regex. 3.14 re-reads every entry here.
 */
export const HEURISTIC_EXEMPTIONS = [
  {
    route: 'POST /api/engagement/outreach/:id/open-email',
    reason:
      'Builds a mailto: URL locally and flips the record to opened_in_email. No provider API call.',
    evidence: 'apps/api/src/engagement/engagement.service.ts:2515 openOutreachInConnectedEmail',
    actualClassification: 'safe_local_write',
  },
  {
    route: 'POST /api/engagement/outreach/send-intents/:id/cancel',
    reason:
      'One Prisma transaction: marks pending deliveries skipped and the intent canceled. Stops sends rather than causing one; contacts nothing.',
    evidence: 'apps/api/src/engagement/outreach-send-intent.service.ts:537 cancelIntent',
    actualClassification: 'safe_local_write',
  },
];

const EXEMPT_ROUTES = new Map(HEURISTIC_EXEMPTIONS.map((e) => [e.route, e]));

export function classifyRequest(method, routePath, runtimeAction) {
  if (runtimeAction) {
    return {
      classification: 'external_action',
      why: `@EngagementRuntimeAction('${runtimeAction}')`,
    };
  }
  if (method === 'GET') return { classification: 'read', why: 'read-only' };
  return { classification: 'safe_local_write', why: 'database-local write, no declared external action' };
}

// ──────────────────────────────────────────────────────────────────── scanner

const SKIP_FILE = /\.(test|spec)\.[tj]sx?$/;
const SKIP_DIR = /(^|[\\/])(node_modules|__tests__|__mocks__|dist|build)([\\/]|$)/;

export function listSourceFiles(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current).sort()) {
      const full = path.join(current, entry);
      const rel = path.relative(ROOT, full).split(path.sep).join('/');
      if (SKIP_DIR.test(rel)) continue;
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.[tj]sx?$/.test(entry) || SKIP_FILE.test(entry)) continue;
      out.push(rel);
    }
  };
  walk(dir);
  return out;
}

/** Module-level `const X = '<literal>'` table, used to resolve `${BASE}/...`. */
export function collectStringConstants(source) {
  const table = new Map();
  const re = /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=\s*'([^']*)'\s*;?\s*$/gm;
  let m;
  while ((m = re.exec(source)) !== null) table.set(m[1], m[2]);
  return table;
}

/** Extract the argument list source starting at the '(' index, balanced. */
function readCallArgs(source, openParenIndex) {
  let depth = 0;
  let quote = null;
  let templateDepth = 0;
  for (let i = openParenIndex; i < source.length; i += 1) {
    const ch = source[i];
    const prev = source[i - 1];
    if (quote) {
      if (ch === quote && prev !== '\\') quote = null;
      else if (quote === '`' && ch === '{' && prev === '$') templateDepth += 1;
      else if (quote === '`' && ch === '}' && templateDepth > 0) templateDepth -= 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openParenIndex + 1, i);
    }
  }
  return null;
}

/** Resolve the first argument of a call to a concrete route path, or null. */
export function resolveFirstArgPath(argsSource, constants) {
  if (argsSource === null) return null;
  const trimmed = argsSource.trimStart();

  if (trimmed.startsWith("'")) {
    const end = trimmed.indexOf("'", 1);
    return end === -1 ? null : { path: trimmed.slice(1, end), dynamic: false };
  }
  if (trimmed.startsWith('`')) {
    const end = findTemplateEnd(trimmed);
    if (end === -1) return null;
    const raw = trimmed.slice(1, end);
    let dynamic = false;
    const resolved = raw.replace(/\$\{([^}]*)\}/g, (_full, expr) => {
      const name = expr.trim();
      if (constants.has(name)) return constants.get(name);
      dynamic = true;
      return ':param';
    });
    return { path: resolved, dynamic };
  }
  return null;
}

function findTemplateEnd(source) {
  let depth = 0;
  for (let i = 1; i < source.length; i += 1) {
    const ch = source[i];
    if (source[i - 1] === '\\') continue;
    if (ch === '{' && source[i - 1] === '$') depth += 1;
    else if (ch === '}' && depth > 0) depth -= 1;
    else if (ch === '`' && depth === 0) return i;
  }
  return -1;
}

/** Nearest enclosing exported/declared symbol above `index`. */
export function enclosingSymbol(source, index) {
  const head = source.slice(0, index);
  const patterns = [
    /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /export\s+const\s+([A-Za-z_$][\w$]*)\s*[:=]/g,
    /(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /(?:^|\n)\s*const\s+([A-Za-z_$][\w$]*)\s*[:=]/g,
  ];
  let best = { index: -1, name: null };
  for (const re of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(head)) !== null) {
      if (m.index > best.index) best = { index: m.index, name: m[1] };
    }
  }
  return best.name ?? '<module>';
}

const METHOD_CALL = /\b(?:api|client|apiClient)\s*\.\s*(get|post|put|patch|delete)\s*(?:<[^(]*?>)?\s*\(/g;

/**
 * Index of URL-builder helpers, e.g.
 *   export const intelTrackerPaths = { feedback: (c) => `/intel-api/.../feedback` }
 *   export const somePath = (id) => `/api/engagement/...`
 *
 * Maps `intelTrackerPaths.feedback` and `somePath` to the literal prefix of the
 * template they return. Without this the scanner cannot tell a non-Engagement
 * helper call apart from an Engagement one it failed to parse, and fails closed
 * on both — turning every unrelated helper into a false finding.
 */
export function buildHelperIndex(root = ROOT) {
  const index = new Map();
  const record = (key, value) => {
    if (typeof value === 'string' && value.startsWith('/')) index.set(key, value);
  };

  for (const rel of listSourceFiles(path.join(root, 'apps/web/src'))) {
    const source = readFileSync(path.join(root, rel), 'utf8');

    // export const NAME = { member: (...) => `/path...` | '/path...' , ... }
    const objectRe = /export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*\{/g;
    let objectMatch;
    while ((objectMatch = objectRe.exec(source)) !== null) {
      const body = readCallArgs(source, objectRe.lastIndex - 1);
      if (body === null) continue;
      const memberRe = /([A-Za-z_$][\w$]*)\s*:\s*\([^)]*\)\s*(?::\s*[^=]+)?=>\s*(?:`([^`]*)|'([^']*)')/g;
      let memberMatch;
      while ((memberMatch = memberRe.exec(body)) !== null) {
        const literal = memberMatch[2] ?? memberMatch[3] ?? '';
        record(`${objectMatch[1]}.${memberMatch[1]}`, literal.split('${')[0]);
      }
    }

    // export const NAME = (...) => `/path...`
    const arrowRe =
      /export\s+const\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=\s*\([^)]*\)\s*(?::\s*[^=]+)?=>\s*(?:`([^`]*)|'([^']*)')/g;
    let arrowMatch;
    while ((arrowMatch = arrowRe.exec(source)) !== null) {
      const literal = arrowMatch[2] ?? arrowMatch[3] ?? '';
      record(arrowMatch[1], literal.split('${')[0]);
    }
  }
  return index;
}

/** Resolve `helperObject.member(...)` / `helper(...)` to its literal prefix. */
export function resolveHelperCall(argsSource, helperIndex) {
  if (!argsSource) return null;
  const match = /^\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*\(/.exec(argsSource);
  if (!match) return null;
  const prefix = helperIndex.get(match[1]);
  return prefix === undefined ? null : { path: prefix, viaHelper: match[1] };
}

export function scanFile(relPath, source, helperIndex = new Map()) {
  const constants = collectStringConstants(source);
  const requests = [];
  const findings = [];

  METHOD_CALL.lastIndex = 0;
  let m;
  while ((m = METHOD_CALL.exec(source)) !== null) {
    const method = m[1].toUpperCase();
    const openParen = source.indexOf('(', m.index + m[0].length - 1);
    const args = readCallArgs(source, openParen);
    const resolved = resolveFirstArgPath(args, constants) ?? resolveHelperCall(args, helperIndex);

    if (!resolved) {
      const snippet = source.slice(m.index, m.index + 80).split('\n')[0];
      findings.push({
        kind: 'unresolvable_request_url',
        consumerFile: relPath,
        line: lineOf(source, m.index),
        detail: `could not resolve the URL argument of ${snippet.trim()}`,
      });
      continue;
    }
    if (!resolved.path.startsWith(ENGAGEMENT_PREFIX)) continue;

    requests.push({
      consumerFile: relPath,
      consumerSymbol: enclosingSymbol(source, m.index),
      line: lineOf(source, m.index),
      method,
      requestPath: normalizePath(resolved.path),
    });
  }

  return { requests, findings };
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

/** Strip query strings and collapse every dynamic segment to `:param`. */
export function normalizePath(raw) {
  const withoutQuery = raw.split('?')[0].replace(/\/+$/, '') || raw;
  return withoutQuery
    .split('/')
    .map((segment) => (segment.includes(':param') ? ':param' : segment))
    .join('/');
}

// ────────────────────────────────────────────────────────────── route mapping

/**
 * Match a scanned request against the Phase 0 route manifest.
 * Literal segments win over parameter segments so `/meetings/library` cannot be
 * absorbed by `/meetings/:meetingId`.
 */
export function matchRoute(routes, method, requestPath) {
  const requestSegments = requestPath.split('/');
  const candidates = routes.filter((route) => {
    if (route.method !== method) return false;
    const routeSegments = route.path.split('/');
    if (routeSegments.length !== requestSegments.length) return false;
    return routeSegments.every((segment, i) => {
      const requested = requestSegments[i];
      if (segment.startsWith(':')) return true;
      return segment === requested;
    });
  });
  if (candidates.length === 0) return null;

  const score = (route) =>
    route.path
      .split('/')
      .reduce((total, segment, i) => {
        if (segment.startsWith(':')) return total;
        return requestSegments[i] === segment ? total + 1 : total;
      }, 0);

  return candidates.sort((a, b) => score(b) - score(a) || a.path.localeCompare(b.path))[0];
}

export function surfaceForFile(relPath) {
  return SURFACES.find((surface) => surface.files.includes(relPath)) ?? null;
}

/** Deterministic, human-readable action label derived from the consumer symbol. */
export function userActionFor(symbol, method, routePath) {
  if (symbol && symbol !== '<module>') {
    const words = symbol
      .replace(/^use/, '')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .trim()
      .toLowerCase();
    if (words) return words;
  }
  return `${method.toLowerCase()} ${routePath}`;
}

// ──────────────────────────────────────────────────────────────────── builder

export function buildUiInventory({ root = ROOT, routeManifest } = {}) {
  const manifest =
    routeManifest ?? JSON.parse(readFileSync(ROUTE_MANIFEST_PATH, 'utf8'));
  const files = listSourceFiles(path.join(root, 'apps/web/src'));
  const helperIndex = buildHelperIndex(root);
  const runtimeActions = collectRuntimeActions(root);

  const requests = [];
  const findings = [];

  for (const rel of files) {
    const source = readFileSync(path.join(root, rel), 'utf8');
    if (!source.includes(ENGAGEMENT_PREFIX) && !source.includes('${BASE}')) continue;
    const scanned = scanFile(rel, source, helperIndex);
    requests.push(...scanned.requests);
    findings.push(...scanned.findings.filter((f) => f.consumerFile.includes('engagement')));
  }

  const entries = requests
    .map((request) => {
      const route = matchRoute(manifest.routes, request.method, request.requestPath);
      const surface = surfaceForFile(request.consumerFile);
      const routePath = route ? route.path : request.requestPath;
      const runtimeAction = route
        ? runtimeActions.get(`${route.sourceFile}#${route.handler}`) ?? null
        : null;
      const { classification, why } = classifyRequest(request.method, routePath, runtimeAction);
      return {
        consumerFile: request.consumerFile,
        consumerSymbol: request.consumerSymbol,
        method: request.method,
        requestPath: request.requestPath,
        routeManifestKey: route ? `${route.method} ${route.path}` : null,
        surface: surface ? surface.id : null,
        userAction: userActionFor(request.consumerSymbol, request.method, request.requestPath),
        classification,
        classificationReason: why,
        runtimeAction,
        heuristicClassification: heuristicClassify(request.method, routePath).classification,
      };
    })
    .sort(
      (a, b) =>
        a.consumerFile.localeCompare(b.consumerFile) ||
        a.method.localeCompare(b.method) ||
        a.requestPath.localeCompare(b.requestPath) ||
        a.consumerSymbol.localeCompare(b.consumerSymbol),
    );

  // Deduplicate identical (file, symbol, method, path) tuples — the same hook
  // called twice in one module is one parity obligation, not two.
  const deduped = [];
  const seen = new Set();
  for (const entry of entries) {
    const key = `${entry.consumerFile}|${entry.consumerSymbol}|${entry.method}|${entry.requestPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(entry);
  }

  const consumerFiles = [...new Set(deduped.map((e) => e.consumerFile))].sort();

  // Coverage across the WHOLE Phase 0 route manifest, not just what the web
  // happens to call. A route with no consumer is recorded as `api_only` on
  // purpose: Phase 3 proves UI parity, so an unconsumed route is out of the
  // browser workload — but it has to be named as such rather than simply
  // missing, or the inventory would understate what it did not check.
  const consumersByRoute = new Map();
  for (const entry of deduped) {
    if (!entry.routeManifestKey) continue;
    if (!consumersByRoute.has(entry.routeManifestKey)) {
      consumersByRoute.set(entry.routeManifestKey, new Set());
    }
    consumersByRoute.get(entry.routeManifestKey).add(entry.consumerFile);
  }

  const routeCoverage = manifest.routes
    .map((route) => {
      const key = `${route.method} ${route.path}`;
      const consumers = [...(consumersByRoute.get(key) ?? [])].sort();
      const runtimeAction = runtimeActions.get(`${route.sourceFile}#${route.handler}`) ?? null;
      return {
        routeManifestKey: key,
        status: consumers.length > 0 ? 'consumed' : 'api_only',
        consumers,
        runtimeAction,
      };
    })
    .sort((a, b) => a.routeManifestKey.localeCompare(b.routeManifestKey));

  return {
    schemaVersion: SCHEMA_VERSION,
    description:
      'Every current Engagement UI surface and API consumer Phase 3 must prove parity for. Generated by scripts/engagement-phase3-ui-inventory.mjs; do not hand-edit.',
    surfaces: SURFACES.map((surface) => ({
      id: surface.id,
      title: surface.title,
      owner: surface.owner,
      spaRoutes: surface.spaRoutes,
      files: [...surface.files].sort(),
      // Every surface must render these four states in both modes. 3.6-3.11
      // consume this list; an empty one would silently shrink the workload.
      requiredStates: ['loading', 'empty', 'error', 'permission_denied'],
    })),
    consumerFiles,
    routeCoverage,
    heuristicExemptions: HEURISTIC_EXEMPTIONS,
    requests: deduped,
    findings: findings.sort(
      (a, b) => a.consumerFile.localeCompare(b.consumerFile) || a.line - b.line,
    ),
    totals: {
      surfaces: SURFACES.length,
      consumerFiles: consumerFiles.length,
      requests: deduped.length,
      routesTotal: routeCoverage.length,
      routesConsumed: routeCoverage.filter((r) => r.status === 'consumed').length,
      routesApiOnly: routeCoverage.filter((r) => r.status === 'api_only').length,
      read: deduped.filter((e) => e.classification === 'read').length,
      safeLocalWrite: deduped.filter((e) => e.classification === 'safe_local_write').length,
      externalAction: deduped.filter((e) => e.classification === 'external_action').length,
    },
  };
}

// ─────────────────────────────────────────────────────────────────── verifier

export function verifyUiInventory(inventory, routeManifest) {
  const problems = [];
  const manifest =
    routeManifest ?? JSON.parse(readFileSync(ROUTE_MANIFEST_PATH, 'utf8'));

  if (inventory.schemaVersion !== SCHEMA_VERSION) {
    problems.push(`schemaVersion must be ${SCHEMA_VERSION}, found ${inventory.schemaVersion}`);
  }
  if (!Array.isArray(inventory.requests) || inventory.requests.length === 0) {
    problems.push('inventory has no requests; the scanner found nothing');
    return problems;
  }

  const routeKeys = new Set(manifest.routes.map((r) => `${r.method} ${r.path}`));

  for (const entry of inventory.requests) {
    const where = `${entry.consumerFile}:${entry.consumerSymbol} ${entry.method} ${entry.requestPath}`;

    // Required test: every request maps to the Phase 0 route manifest.
    if (!entry.routeManifestKey) {
      problems.push(`${where} does not map to any Phase 0 route manifest entry`);
    } else if (!routeKeys.has(entry.routeManifestKey)) {
      problems.push(`${where} maps to unknown route key ${entry.routeManifestKey}`);
    }

    // Required test: every request belongs to a reviewed surface.
    if (!entry.surface) {
      problems.push(`${where} has no surface; add its file to the SURFACES table`);
    }

    // Required test: every request is classified.
    if (!['read', 'safe_local_write', 'external_action'].includes(entry.classification)) {
      problems.push(`${where} has invalid classification "${entry.classification}"`);
    }

    // A GET can never be a local write. It may be external (an OAuth callback
    // is a decorated GET), but "GET that writes rows" is always a mistake.
    if (entry.method === 'GET' && entry.classification === 'safe_local_write') {
      problems.push(`${where} is a GET but classified safe_local_write`);
    }

    // The cross-check that gives the decorator-driven classification its teeth:
    // a route the heuristics read as external, carrying no runtime-action
    // decorator, is an undeclared external endpoint. engagement-api would let it
    // through in shadow mode — a genuine containment hole, not a naming quibble.
    if (
      entry.heuristicClassification === 'external_action' &&
      !entry.runtimeAction &&
      !EXEMPT_ROUTES.has(entry.routeManifestKey)
    ) {
      problems.push(
        `${where} looks like an external action (${heuristicClassify(entry.method, entry.requestPath).why}) ` +
          'but its handler carries no @EngagementRuntimeAction; shadow mode would not deny it. ' +
          'Add the decorator, or add an evidence-backed entry to HEURISTIC_EXEMPTIONS',
      );
    }
  }

  // An exemption must describe a route the inventory actually contains,
  // otherwise a stale entry silently disarms the cross-check for a route that
  // has since changed shape.
  const presentRoutes = new Set(inventory.requests.map((e) => e.routeManifestKey));
  for (const exemption of HEURISTIC_EXEMPTIONS) {
    if (!presentRoutes.has(exemption.route)) {
      problems.push(
        `HEURISTIC_EXEMPTIONS lists ${exemption.route}, which no consumer calls; remove the stale exemption`,
      );
    }
  }

  // Required test: the send endpoints are never classified read (negative
  // control 3.1 names explicitly). Matches send-batch and jobs/send too, which
  // an over-anchored /send$/ pattern would miss.
  for (const entry of inventory.requests) {
    if (
      /\/send(-|$)|\/send-intents?(\/|$)/.test(entry.requestPath) &&
      entry.method !== 'GET' &&
      !EXEMPT_ROUTES.has(entry.routeManifestKey)
    ) {
      if (entry.classification !== 'external_action') {
        problems.push(`send endpoint ${entry.method} ${entry.requestPath} must be external_action`);
      }
    }
  }

  // Required test: Outreach v2 is the sole production wizard, and OutreachView
  // is present. Negative control 3.1 names the omission case.
  const files = new Set(inventory.consumerFiles);
  if (!files.has('apps/web/src/pages/engagement/OutreachView.tsx')) {
    problems.push('OutreachView.tsx is missing from the consumer inventory');
  }
  if (!files.has('apps/web/src/pages/engagement/meetings/meetings-api.ts')) {
    problems.push('meetings-api.ts is missing from the consumer inventory');
  }

  // Required test: no V3 route or component exists in the inventory.
  for (const entry of inventory.requests) {
    if (/outreach\/v3|outreach-v3/i.test(entry.consumerFile)) {
      problems.push(`Outreach V3 consumer found: ${entry.consumerFile}`);
    }
    if (/\/outreach\/v3(\/|$)|\/campaign-spec|\/checkpoints/.test(entry.requestPath)) {
      problems.push(`Outreach V3 route found: ${entry.requestPath}`);
    }
  }

  // Required test: every user-facing Engagement route has a consumer or an
  // explicit api_only status — no route may simply be absent.
  const coverageKeys = new Set((inventory.routeCoverage ?? []).map((r) => r.routeManifestKey));
  for (const key of routeKeys) {
    if (!coverageKeys.has(key)) {
      problems.push(`route ${key} has no coverage entry (neither consumed nor api_only)`);
    }
  }
  for (const entry of inventory.routeCoverage ?? []) {
    if (!['consumed', 'api_only'].includes(entry.status)) {
      problems.push(`route ${entry.routeManifestKey} has invalid coverage status "${entry.status}"`);
    }
    if (entry.status === 'consumed' && entry.consumers.length === 0) {
      problems.push(`route ${entry.routeManifestKey} is marked consumed with no consumers`);
    }
    if (entry.status === 'api_only' && entry.consumers.length > 0) {
      problems.push(`route ${entry.routeManifestKey} is marked api_only but has consumers`);
    }
  }

  // Required test: every surface declares its four required states.
  for (const surface of inventory.surfaces ?? []) {
    for (const state of ['loading', 'empty', 'error', 'permission_denied']) {
      if (!surface.requiredStates?.includes(state)) {
        problems.push(`surface ${surface.id} is missing required state "${state}"`);
      }
    }
  }

  // Required test: no unresolvable Engagement request URL escaped the scan.
  for (const finding of inventory.findings ?? []) {
    problems.push(
      `${finding.consumerFile}:${finding.line} ${finding.kind} — ${finding.detail}`,
    );
  }

  // Totals must agree with the request list, so a hand-edited manifest fails.
  const recount = {
    read: inventory.requests.filter((e) => e.classification === 'read').length,
    safeLocalWrite: inventory.requests.filter((e) => e.classification === 'safe_local_write').length,
    externalAction: inventory.requests.filter((e) => e.classification === 'external_action').length,
  };
  for (const [key, value] of Object.entries(recount)) {
    if (inventory.totals?.[key] !== value) {
      problems.push(`totals.${key} says ${inventory.totals?.[key]}, actual ${value}`);
    }
  }
  if (inventory.totals?.requests !== inventory.requests.length) {
    problems.push(
      `totals.requests says ${inventory.totals?.requests}, actual ${inventory.requests.length}`,
    );
  }

  return problems;
}

// ───────────────────────────────────────────────────────────────────────── CLI

function main(argv) {
  const checkIndex = argv.indexOf('--check');
  const writeIndex = argv.indexOf('--write');
  // Read the operand of whichever flag is actually present. Using
  // `argv[checkIndex + 1]` unconditionally resolves to argv[0] when --check is
  // absent, which silently writes the manifest to a file named "--write".
  const target = checkIndex !== -1 ? argv[checkIndex + 1] : argv[writeIndex + 1];

  if ((checkIndex === -1 && writeIndex === -1) || !target) {
    console.error('usage: engagement-phase3-ui-inventory.mjs --check|--write <manifest.json>');
    return 1;
  }

  const built = buildUiInventory();

  if (writeIndex !== -1) {
    writeFileSync(path.resolve(target), `${JSON.stringify(built, null, 2)}\n`);
    console.log(
      `wrote ${target}: ${built.totals.requests} requests, ${built.totals.consumerFiles} consumers, ` +
        `${built.totals.surfaces} surfaces ` +
        `(${built.totals.read} read / ${built.totals.safeLocalWrite} safe-local-write / ${built.totals.externalAction} external)`,
    );
    return 0;
  }

  let committed;
  try {
    committed = JSON.parse(readFileSync(path.resolve(target), 'utf8'));
  } catch (error) {
    console.error(`cannot read ${target}: ${error.message}`);
    return 1;
  }

  const problems = verifyUiInventory(committed);
  if (JSON.stringify(committed) !== JSON.stringify(built)) {
    problems.unshift(
      'committed manifest is stale — re-run with --write (the web source changed)',
    );
  }

  if (problems.length > 0) {
    console.error(`ENGAGEMENT_PHASE3_UI_INVENTORY_INVALID (${problems.length})`);
    for (const problem of problems) console.error(`  - ${problem}`);
    return 1;
  }

  console.log(
    `ENGAGEMENT_PHASE3_UI_INVENTORY_OK: ${committed.totals.requests} requests across ` +
      `${committed.totals.consumerFiles} consumers and ${committed.totals.surfaces} surfaces ` +
      `(${committed.totals.read} read / ${committed.totals.safeLocalWrite} safe-local-write / ${committed.totals.externalAction} external)`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('engagement-phase3-ui-inventory.mjs')) {
  process.exit(main(process.argv.slice(2)));
}
