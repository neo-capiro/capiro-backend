#!/usr/bin/env node
/** Current backend source declarations and preview boundary; no frontend parity. */
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectRuntimeActions, classifyRequest, heuristicClassify, HEURISTIC_EXEMPTIONS,
  loadBackendUiInventory,
} from './engagement-phase3-ui-inventory.mjs';
import { buildPatterns, pathToPattern, PREVIEW_PREFIX, EXCLUSIONS } from './engagement-phase3-preview-route-patterns.mjs';
import { readLegacySourceInput } from '../tests/support/legacy-web/inputs.mjs';
import { readVisualCliInput } from '../tests/support/legacy-web/visual-cli-inputs/inputs.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ROUTE_INPUTS = Object.freeze([
  'apps/api/src/engagement/__fixtures__/engagement-route-manifest.v1.json',
  ...['', '-reasoning', '-target', '-context', '-generation', '-drafts', '-send', '-templates']
    .map(part => `apps/api/src/outreach-v3/__fixtures__/outreach-v3${part}-route-manifest.v1.json`),
]);
// Per-input source contracts. Five schemaVersion manifests have no controller
// prefix fields; their admitted namespaces are explicit here, not invented on
// the manifest or inferred from whichever first route happens to be present.
const ADDITIVE_OWNERS = new Map(ROUTE_INPUTS.slice(1).map((input, index) => [input, {
  schemaKey: [0, 1, 7].includes(index) ? 'version' : 'schemaVersion',
  declaredPrefixes: [0, 1, 7].includes(index),
  controllerPrefix: index === 7 ? '/engagement/outreach-v3/templates' : '/engagement/outreach-v3',
  ownerPath: index < 2 ? '/api/engagement/outreach-v3' : index === 7 ? '/api/engagement/outreach-v3/templates' :
    `/api/engagement/outreach-v3/sessions/:sessionId/${['targets', 'context', 'generation', 'drafts', 'send'][index - 2]}`,
}]));
const withinOwner = (routePath, owner) => typeof routePath === 'string' && (routePath === owner || routePath.startsWith(`${owner}/`));
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const OTHER_PRIMARY_OWNERS = new Set([
  'apps/api/src/ai-credentials/internal-ai-credentials.controller.ts',
  'apps/api/src/webhooks/recall-webhook.controller.ts',
]);
const sourcePath = value => typeof value === 'string' &&
  (/^apps\/api\/src\/engagement\/[A-Za-z0-9_./-]+\.controller\.ts$/.test(value) || OTHER_PRIMARY_OWNERS.has(value)) &&
  !value.split('/').some(part => part === '..' || part === '.');
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const keyOf = route => `${route.method} ${route.path}`;

function readOwnedFile(root, relative) {
  const resolvedRoot = realpathSync(root);
  const absolute = path.resolve(root, relative);
  const actual = realpathSync(absolute);
  const rel = path.relative(resolvedRoot, actual);
  if (path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`) ||
      lstatSync(absolute).isSymbolicLink() || !lstatSync(absolute).isFile()) {
    throw new Error(`Backend contract input escapes its regular-file owner: ${relative}`);
  }
  return readFileSync(actual, 'utf8');
}

/** Finite source reads. This does not load a Nest app or establish live routing. */
export function readCurrentBackendInputs(root = ROOT) {
  const manifests = ROUTE_INPUTS.map((input, index) => ({
    input, kind: index === 0 ? 'primary' : 'additive',
    manifest: JSON.parse(readOwnedFile(root, input)),
  }));
  const sourceEvidence = new Map();
  for (const route of manifests[0].manifest.routes ?? []) {
    if (sourcePath(route.sourceFile) && !sourceEvidence.has(route.sourceFile)) {
      sourceEvidence.set(route.sourceFile, readOwnedFile(root, route.sourceFile));
    }
  }
  return { manifests, sourceEvidence, runtimeActions: collectRuntimeActions(root) };
}

/** Pure validation of current backend-owned declarations, independent of UI consumers. */
export function buildBackendRouteCatalog({ manifests, sourceEvidence, runtimeActions }) {
  const issues = [];
  const routes = [];
  const keys = new Set();
  const exemptions = new Map(HEURISTIC_EXEMPTIONS.map(row => [row.route, row]));
  if (!Array.isArray(manifests) || manifests.length !== ROUTE_INPUTS.length ||
      manifests.some((row, index) => row.input !== ROUTE_INPUTS[index] ||
        row.kind !== (index === 0 ? 'primary' : 'additive'))) {
    return { issues: ['Current route manifest ownership list is incomplete or reordered'], routes: [] };
  }
  for (const { input, kind, manifest } of manifests) {
    if (!manifest || !Number.isInteger(manifest.schemaVersion ?? manifest.version) ||
        (manifest.schemaVersion ?? manifest.version) < 1 ||
        !Array.isArray(manifest.routes) || manifest.routes.length === 0) {
      issues.push(`${input}: invalid or empty route manifest`);
      continue;
    }
    if (kind === 'additive' && manifest.runtime !== 'engagement-api') {
      issues.push(`${input}: additive runtime declaration must remain engagement-api`);
    }
    let ownerPath = null;
    if (kind === 'additive') {
      const owner = ADDITIVE_OWNERS.get(input);
      ownerPath = owner.ownerPath;
      if (!Number.isInteger(manifest[owner.schemaKey]) || manifest[owner.schemaKey] < 1) {
        issues.push(`${input}: expected ${owner.schemaKey} schema metadata`);
      }
      const hasGlobal = Object.hasOwn(manifest, 'globalPrefix');
      const hasController = Object.hasOwn(manifest, 'controllerPrefix');
      if (owner.declaredPrefixes || hasGlobal || hasController) {
        if (!hasGlobal || !hasController || manifest.globalPrefix !== '/api' ||
            manifest.controllerPrefix !== owner.controllerPrefix) {
          issues.push(`${input}: declared global/controller prefix metadata differs from its admitted owner`);
        } else if (owner.declaredPrefixes) ownerPath = manifest.globalPrefix + manifest.controllerPrefix;
      }
    } else if (manifest.globalPrefix !== '/api') issues.push(`${input}: primary global prefix declaration must remain /api`);
    for (const route of manifest.routes) {
      const key = keyOf(route);
      if (!METHODS.has(route.method)) issues.push(`${input}: unsupported route method ${route.method}`);
      if (typeof route.path !== 'string' || !route.path.startsWith('/') ||
          /[?#\\\s]/.test(route.path) || route.path.split('/').includes('..')) {
        issues.push(`${input}: invalid absolute route path ${route.path}`);
      }
      if (!IDENTIFIER.test(route.handler ?? '')) issues.push(`${key}: invalid handler declaration`);
      if (keys.has(key)) issues.push(`${key}: duplicate backend route key`);
      keys.add(key);
      if (kind === 'additive' && !route.path?.startsWith(`${PREVIEW_PREFIX}/`)) {
        issues.push(`${key}: additive route escapes its declared Engagement prefix`);
      }
      if (kind === 'additive' && !withinOwner(route.path, ownerPath)) {
        issues.push(`${key}: additive route is outside its composed declared owner prefix ${ownerPath}`);
      }
      let runtimeAction = null;
      let classification = null;
      if (kind === 'primary') {
        const source = sourceEvidence.get(route.sourceFile);
        if (!sourcePath(route.sourceFile) || typeof source !== 'string') {
          issues.push(`${key}: missing owned controller source ${route.sourceFile}`);
        } else {
          if (!IDENTIFIER.test(route.controller ?? '') ||
              !new RegExp(`\\bclass\\s+${escape(route.controller ?? '')}\\b`).test(source)) {
            issues.push(`${key}: declared controller is absent from its source`);
          }
          if (IDENTIFIER.test(route.handler ?? '') && !new RegExp(
            `^\\s*(?:(?:public|private|protected|override)\\s+)*(?:async\\s+)?${escape(route.handler)}\\s*\\(`, 'm',
          ).test(source)) issues.push(`${key}: declared handler is absent from its source`);
        }
        // The existing action scanner owns Engagement controllers only. The
        // credential/webhook declarations stay catalogued and outside preview;
        // this gate does not invent a local-action classification for them.
        const engagementOwned = route.sourceFile?.startsWith('apps/api/src/engagement/');
        runtimeAction = engagementOwned ? runtimeActions.get(`${route.sourceFile}#${route.handler}`) ?? null : null;
        classification = engagementOwned ? classifyRequest(route.method, route.path, runtimeAction).classification : null;
        if (route.method === 'GET' && classification === 'safe_local_write') {
          issues.push(`${key}: GET cannot be classified as a local write`);
        }
        const heuristic = heuristicClassify(route.method, route.path);
        if (route.path?.startsWith(`${PREVIEW_PREFIX}/`) &&
            heuristic.classification === 'external_action' && !runtimeAction && !exemptions.has(key)) {
          issues.push(`${key}: external-looking handler has no declared runtime action`);
        }
        if (/\/send(-|$)|\/send-intents?(\/|$)/.test(route.path) && route.method !== 'GET' &&
            !exemptions.has(key) && classification !== 'external_action') {
          issues.push(`${key}: send handler must declare an external runtime action`);
        }
      }
      routes.push({
        key, method: route.method, path: route.path, handler: route.handler, input, kind, ownerPath,
        sourceFile: kind === 'primary' ? route.sourceFile : null,
        classification, runtimeAction,
        classificationSource: kind === 'primary' && route.sourceFile?.startsWith('apps/api/src/engagement/')
          ? 'current-controller-decorator-or-method' : 'separate-owned-route-contract',
      });
    }
  }
  for (const exemption of HEURISTIC_EXEMPTIONS) {
    if (!keys.has(exemption.route) || exemption.reason.length < 30 || !/\.ts:\d+/.test(exemption.evidence)) {
      issues.push(`${exemption.route}: stale or undocumented heuristic exemption`);
    }
  }
  routes.sort((a, b) => a.key.localeCompare(b.key));
  return {
    scope: 'current-backend-source-declarations', issues, routes,
    summary: { manifests: manifests.length, routes: routes.length,
      primary: routes.filter(row => row.kind === 'primary').length,
      additive: routes.filter(row => row.kind === 'additive').length },
  };
}

/** Checks the existing prefix's boundary; it grants no new browser authority. */
export function verifyBackendPreviewBoundary(catalog, built = buildPatterns({ routes: catalog.routes }),
  policy = { prefix: PREVIEW_PREFIX, exclusions: EXCLUSIONS }) {
  const issues = [];
  // Preserve the existing reviewed policy, rather than add exceptions for new
  // catalog paths. Legitimate non-preview backend routes remain outside it.
  if (policy.prefix !== '/api/engagement' || JSON.stringify(policy.exclusions.map(row => row.path)) !==
      JSON.stringify(['/api/internal/ai-credentials/resolve', '/webhooks/recall'])) {
    issues.push('Reviewed preview prefix/exclusion policy changed');
  }
  const paths = [...new Set(catalog.routes.map(route => route.path))].sort();
  const inside = paths.filter(routePath => routePath.startsWith(`${PREVIEW_PREFIX}/`));
  const outside = paths.filter(routePath => !routePath.startsWith(`${PREVIEW_PREFIX}/`));
  if (inside.length === 0) issues.push('Current backend catalog has no Engagement preview-prefix routes');
  if (JSON.stringify(built.coveredPaths) !== JSON.stringify(inside) ||
      JSON.stringify(built.patterns) !== JSON.stringify(inside.map(pathToPattern))) {
    issues.push('Preview boundary patterns differ from exact in-prefix backend declarations');
  }
  for (const pattern of built.patterns) {
    if (!pattern.startsWith('^') || !pattern.endsWith('$')) {
      issues.push(`Unanchored preview pattern: ${pattern}`);
      continue;
    }
    let regex;
    try { regex = new RegExp(pattern); } catch { issues.push(`Invalid preview pattern: ${pattern}`); continue; }
    for (const routePath of outside) {
      if (regex.test(routePath.replace(/:[A-Za-z_$][\w$]*/g, 'boundary-probe'))) {
        issues.push(`Preview pattern includes non-preview backend route: ${routePath}`);
      }
    }
  }
  return { issues, previewPaths: inside, nonPreviewPaths: outside,
    historicalGeneratorUnaccounted: built.unaccounted,
    scope: 'backend-pattern-boundary-only; browser-table-generation-and-frontend-parity-not-performed' };
}

export function verifyOwnedHistoricalInputs(root = ROOT) {
  const inventory = loadBackendUiInventory(root);
  const generated = readLegacySourceInput('engagement-api-preview-routes.generated.ts.txt');
  const historicalPackage = readVisualCliInput('package.json');
  return { purpose: 'immutable-qualification-data-identity-only',
    inventoryRequests: inventory.requests.length, generatedBytes: generated.length,
    historicalPackageBytes: historicalPackage.length };
}

export function backendContractMode(argv) {
  if (argv.length !== 1 || !['--check-routes', '--check-preview-boundary'].includes(argv[0])) {
    throw new Error('Use exactly --check-routes or --check-preview-boundary');
  }
  return argv[0];
}

export function checkCurrentBackendContract(mode, root = ROOT) {
  backendContractMode([mode]);
  const catalog = buildBackendRouteCatalog(readCurrentBackendInputs(root));
  const inputs = verifyOwnedHistoricalInputs(root);
  const boundary = mode === '--check-preview-boundary' ? verifyBackendPreviewBoundary(catalog) : null;
  return { issues: [...catalog.issues, ...(boundary?.issues ?? [])], summary: catalog.summary,
    inputs, boundary, frontendParityOwner: 'capiro-frontend', liveRoutingAcceptance: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    console.log('Current backend source declarations: --check-routes | --check-preview-boundary. Frontend parity owner: capiro-frontend. No services or generated browser-table writes.');
  } else {
    let mode;
    try { mode = backendContractMode(process.argv.slice(2)); }
    catch (error) { console.error(error.message); process.exit(2); }
    try {
      const result = checkCurrentBackendContract(mode);
      if (result.issues.length) {
        for (const issue of result.issues) console.error(`FAIL ${issue}`);
        console.error('CURRENT_BACKEND_SOURCE_CONTRACT_INVALID');
        process.exit(1);
      }
      console.log('CURRENT_BACKEND_SOURCE_CONTRACT_OK ' + JSON.stringify({ mode, ...result }));
    } catch (error) { console.error(`CURRENT_BACKEND_SOURCE_CONTRACT_INVALID: ${error.message}`); process.exit(1); }
  }
}
