import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import type { EngagementRuntimeActionMetadata } from './engagement-runtime-action.decorator.js';
import {
  ENGAGEMENT_RUNTIME_ROUTE_POLICY,
  type EngagementRuntimeRoutePolicy,
  registryEntries,
  runtimePolicyForHandler,
  sameRuntimeMetadata,
} from './engagement-runtime-route-policy.js';

interface RouteEntry {
  method: string;
  path: string;
  controller: string;
  handler: string;
  sourceFile: string;
  classification:
    | 'read'
    | 'write'
    | 'generation'
    | 'external_send'
    | 'oauth'
    | 'webhook'
    | 'internal_secret'
    | 'sync'
    | 'notetaker'
    | 'attachment';
}

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const ROUTE_MANIFEST = JSON.parse(
  readFileSync(
    path.join(REPO_ROOT, 'apps/api/src/engagement/__fixtures__/engagement-route-manifest.v1.json'),
    'utf8',
  ),
) as { routes: RouteEntry[] };

/**
 * Outreach V3 controllers are not part of the Phase 0 Engagement route manifest
 * (its generator has an explicit seven-controller list). They carry their own
 * frozen per-module manifests instead, so resolve registry entries for those
 * controllers against those manifests rather than exempting them — an orphaned
 * or mistyped V3 registry entry must still be caught here.
 */
const V3_MANIFESTS: ReadonlyArray<{ controller: string; fixture: string }> = [
  {
    controller: 'OutreachV3GenerationController',
    fixture: 'outreach-v3-generation-route-manifest.v1.json',
  },
  {
    controller: 'OutreachV3DraftsController',
    fixture: 'outreach-v3-drafts-route-manifest.v1.json',
  },
  { controller: 'OutreachV3SendController', fixture: 'outreach-v3-send-route-manifest.v1.json' },
];

const V3_ROUTE_KEYS = new Set(
  V3_MANIFESTS.flatMap(({ controller, fixture }) => {
    const manifest = JSON.parse(
      readFileSync(
        path.join(REPO_ROOT, 'apps/api/src/outreach-v3/__fixtures__', fixture),
        'utf8',
      ),
    ) as { routes: Array<{ handler: string }> };
    return manifest.routes.map((route) => `${controller}.${route.handler}`);
  }),
);

const LOCAL_SAFE_GENERATION_HANDLERS = new Set([
  'listDraftArtifacts',
  'getDraftVersion',
  'acceptCandidateVersion',
  // Creates an empty placeholder artifact row (subject/body are always ''); no
  // drafting LLM call or other external boundary crossing occurs.
  'ensureDraftArtifact',
]);
const LOCAL_SAFE_ATTACHMENT_HANDLERS = new Set([
  'attachments',
  'approveMeetingAttachment',
  'createAttachmentUploadUrl',
  'confirmAttachment',
  'deleteAttachment',
]);
const LOCAL_SAFE_OAUTH_HANDLERS = new Set(['capabilities']);
const LOCAL_SAFE_SEND_HANDLERS = new Set([
  'getSendIntent',
  'cancelSendIntent',
  // Updates local state and returns a mailto: URL; no provider send occurs.
  'openOutreachEmail',
]);
const LOCAL_SAFE_NOTETAKER_HANDLERS = new Set(['meetingNotetaker', 'clientNotetaker']);

function externallySensitive(route: RouteEntry): boolean {
  if (route.controller === 'RecallWebhookController') return false;
  if (route.classification === 'internal_secret') return true;
  if (route.classification === 'external_send') {
    return !LOCAL_SAFE_SEND_HANDLERS.has(route.handler);
  }
  if (route.classification === 'sync') return true;
  if (route.classification === 'notetaker') {
    return !LOCAL_SAFE_NOTETAKER_HANDLERS.has(route.handler);
  }
  if (route.classification === 'webhook') return true;
  if (route.classification === 'generation') {
    return !LOCAL_SAFE_GENERATION_HANDLERS.has(route.handler);
  }
  if (route.classification === 'attachment') {
    return !LOCAL_SAFE_ATTACHMENT_HANDLERS.has(route.handler);
  }
  if (route.classification === 'oauth') {
    return !LOCAL_SAFE_OAUTH_HANDLERS.has(route.handler);
  }
  return false;
}

function decoratorMetadata(route: RouteEntry): EngagementRuntimeActionMetadata | undefined {
  const filename = path.join(REPO_ROOT, route.sourceFile);
  const source = readFileSync(filename, 'utf8');
  const sourceFile = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  let result: EngagementRuntimeActionMetadata | undefined;

  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name?.text === route.controller) {
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member) || member.name.getText(sourceFile) !== route.handler) {
          continue;
        }
        for (const decorator of ts.getDecorators(member) ?? []) {
          const expression = decorator.expression;
          if (!ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression)) continue;
          if (expression.expression.text !== 'EngagementRuntimeAction') continue;
          const [actionNode, optionsNode] = expression.arguments;
          if (!actionNode || !ts.isStringLiteral(actionNode)) continue;
          let requiresCallbacks = false;
          let testMode = false;
          if (optionsNode && ts.isObjectLiteralExpression(optionsNode)) {
            for (const property of optionsNode.properties) {
              if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue;
              const value = property.initializer.kind === ts.SyntaxKind.TrueKeyword;
              if (property.name.text === 'requiresCallbacks') requiresCallbacks = value;
              if (property.name.text === 'testMode') testMode = value;
            }
          }
          result = {
            action: actionNode.text as EngagementRuntimeActionMetadata['action'],
            requiresCallbacks,
            testMode,
          };
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return result;
}

function validateRegistry(registry: EngagementRuntimeRoutePolicy): string[] {
  const findings: string[] = [];
  const routeKeys = new Set(
    ROUTE_MANIFEST.routes.map((route) => `${route.controller}.${route.handler}`),
  );

  for (const route of ROUTE_MANIFEST.routes) {
    const metadata = runtimePolicyForHandler(route.controller, route.handler, registry);
    if (externallySensitive(route) && !metadata) {
      findings.push(
        `missing runtime policy: ${route.method} ${route.path} (${route.controller}.${route.handler})`,
      );
    }
    if (
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method) &&
      route.controller !== 'RecallWebhookController' &&
      !metadata &&
      route.classification !== 'write' &&
      !LOCAL_SAFE_GENERATION_HANDLERS.has(route.handler) &&
      !LOCAL_SAFE_ATTACHMENT_HANDLERS.has(route.handler) &&
      !LOCAL_SAFE_SEND_HANDLERS.has(route.handler) &&
      !LOCAL_SAFE_NOTETAKER_HANDLERS.has(route.handler)
    ) {
      findings.push(
        `unclassified mutating route: ${route.method} ${route.path} (${route.controller}.${route.handler})`,
      );
    }
    const decorated = decoratorMetadata(route);
    if (decorated && !metadata) {
      findings.push(`decorator is outside exact registry: ${route.controller}.${route.handler}`);
    }
    if (decorated && metadata && !sameRuntimeMetadata(decorated, metadata)) {
      findings.push(`decorator/registry mismatch: ${route.controller}.${route.handler}`);
    }
    if (
      metadata?.requiresCallbacks &&
      !['integration_oauth_callback', 'integration_notification'].includes(metadata.action)
    ) {
      findings.push(`requiresCallbacks used on non-callback action: ${route.controller}.${route.handler}`);
    }
  }

  for (const entry of registryEntries(registry)) {
    const key = `${entry.controller}.${entry.handler}`;
    if (!routeKeys.has(key) && !V3_ROUTE_KEYS.has(key)) {
      findings.push(`registry entry has no manifest route: ${key}`);
    }
  }
  return findings;
}

describe('Engagement runtime route coverage', () => {
  it('has a nonempty accepted route manifest', () => {
    expect(ROUTE_MANIFEST.routes.length).toBeGreaterThan(0);
  });

  it('covers every externally sensitive route exactly', () => {
    expect(validateRegistry(ENGAGEMENT_RUNTIME_ROUTE_POLICY)).toEqual([]);
  });

  it.each([
    ['createAttachmentUploadUrl', 'POST', '/api/engagement/attachments/upload-url'],
    ['confirmAttachment', 'POST', '/api/engagement/attachments/confirm'],
    ['deleteAttachment', 'DELETE', '/api/engagement/attachments/:id'],
  ])('keeps the real internal storage route %s outside the outbound policy', (handler, method, routePath) => {
    const route = ROUTE_MANIFEST.routes.find(
      (entry) => entry.controller === 'EngagementController' && entry.handler === handler,
    );
    expect(route).toMatchObject({ method, path: routePath, classification: 'attachment' });
    expect(externallySensitive(route!)).toBe(false);
    expect(decoratorMetadata(route!)).toBeUndefined();
    expect(runtimePolicyForHandler('EngagementController', handler!)).toBeUndefined();
  });

  it('classifies the local single-mail intent GET as a read without a send policy', () => {
    const route = ROUTE_MANIFEST.routes.find(
      (entry) => entry.controller === 'EngagementController' && entry.handler === 'singleMailIntent',
    );
    expect(route).toMatchObject({
      method: 'GET', path: '/api/engagement/mail/send-intents/:requestKey', classification: 'read',
    });
    expect(externallySensitive(route!)).toBe(false);
    expect(runtimePolicyForHandler('EngagementController', 'singleMailIntent')).toBeUndefined();
  });

  it.each<[handler: 'send' | 'test', action: 'outreach_send' | 'outreach_test_send', testMode: boolean]>([
    ['send', 'outreach_send', false],
    ['test', 'outreach_test_send', true],
  ])('requires the real Newsletter %s dispatch policy', (handler, action, testMode) => {
    const route = ROUTE_MANIFEST.routes.find(
      (entry) => entry.controller === 'NewsletterOutreachController' && entry.handler === handler,
    );
    expect(route).toMatchObject({
      method: 'POST', path: `/api/engagement/newsletters/:id/${handler}`, classification: 'external_send',
    });
    expect(externallySensitive(route!)).toBe(true);
    expect(runtimePolicyForHandler('NewsletterOutreachController', handler)).toMatchObject({ action });
    expect(runtimePolicyForHandler('NewsletterOutreachController', handler)?.testMode ?? false).toBe(testMode);
    const missing = {
      ...ENGAGEMENT_RUNTIME_ROUTE_POLICY,
      NewsletterOutreachController: { ...ENGAGEMENT_RUNTIME_ROUTE_POLICY.NewsletterOutreachController },
    };
    delete (missing.NewsletterOutreachController as Record<string, unknown>)[handler];
    expect(validateRegistry(missing)).toContain(
      `missing runtime policy: POST /api/engagement/newsletters/:id/${handler} (NewsletterOutreachController.${handler})`,
    );
  });

  it('rejects a Newsletter policy that names no real manifest handler', () => {
    const orphan = {
      ...ENGAGEMENT_RUNTIME_ROUTE_POLICY,
      NewsletterOutreachController: {
        ...ENGAGEMENT_RUNTIME_ROUTE_POLICY.NewsletterOutreachController,
        nonexistentDispatch: { action: 'outreach_send' as const },
      },
    };
    expect(validateRegistry(orphan)).toContain(
      'registry entry has no manifest route: NewsletterOutreachController.nonexistentDispatch',
    );
  });

  it('registers every callback with requiresCallbacks', () => {
    const callbacks = ROUTE_MANIFEST.routes
      .map((route) => ({
        route,
        metadata: runtimePolicyForHandler(route.controller, route.handler),
      }))
      .filter(
        ({ metadata }) =>
          metadata &&
          ['integration_oauth_callback', 'integration_notification'].includes(metadata.action),
      );
    expect(callbacks.length).toBeGreaterThan(0);
    for (const { metadata } of callbacks) {
      expect(metadata?.requiresCallbacks).toBe(true);
    }
  });

  it('names the exact route when one registry entry is removed', () => {
    const clone: Record<string, Record<string, EngagementRuntimeActionMetadata>> = {};
    for (const [controller, handlers] of Object.entries(ENGAGEMENT_RUNTIME_ROUTE_POLICY)) {
      clone[controller] = { ...handlers };
    }
    const engagementHandlers = clone.EngagementController;
    if (!engagementHandlers) {
      throw new Error('EngagementController missing from route policy clone');
    }
    delete engagementHandlers.generateBatchEmails;
    expect(validateRegistry(clone)).toContain(
      'missing runtime policy: POST /api/engagement/outreach/generate-batch (EngagementController.generateBatchEmails)',
    );
  });

  it('keeps mailto local and preserves conditional generation metadata for draft versions', () => {
    expect(runtimePolicyForHandler('EngagementController', 'openOutreachEmail')).toBeUndefined();
    expect(
      runtimePolicyForHandler('EngagementController', 'createDraftVersion'),
    ).toMatchObject({ action: 'outreach_generate' });
  });

  it('keeps Recall outside the Phase 1 application runtime', () => {
    expect(runtimePolicyForHandler('RecallWebhookController', 'receive')).toBeUndefined();
  });
});
