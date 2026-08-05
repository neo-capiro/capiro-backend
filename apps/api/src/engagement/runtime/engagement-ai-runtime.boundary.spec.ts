import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import type { EngagementAiService } from '../engagement-ai.service.js';
import { EngagementRuntimePolicyService } from './engagement-runtime-policy.service.js';
import {
  guardEngagementAiService,
  guardedEngagementAiMethods,
} from './engagement-ai-runtime.boundary.js';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const AI_SERVICE_FILE = path.join(
  REPO_ROOT,
  'apps/api/src/engagement/engagement-ai.service.ts',
);

function shadowPolicy(): EngagementRuntimePolicyService {
  return new EngagementRuntimePolicyService({
    serviceName: 'engagement-api',
    processMode: 'shadow',
    backgroundOwner: 'disabled',
    externalActions: 'disabled',
    callbacksEnabled: false,
    recallWebhookEnabled: false,
  });
}

function providerCapablePublicMethods(): string[] {
  const source = readFileSync(AI_SERVICE_FILE, 'utf8');
  const file = ts.createSourceFile(
    AI_SERVICE_FILE,
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  const methods: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name?.text === 'EngagementAiService') {
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name)) continue;
        const modifiers = ts.getModifiers(member) ?? [];
        if (
          modifiers.some(
            (modifier) =>
              modifier.kind === ts.SyntaxKind.PrivateKeyword ||
              modifier.kind === ts.SyntaxKind.ProtectedKeyword ||
              modifier.kind === ts.SyntaxKind.StaticKeyword,
          )
        ) {
          continue;
        }
        const name = member.name.text;
        if (name.startsWith('generate') || name === 'resolveOutreachCredentials') {
          methods.push(name);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return methods.sort();
}

function productionConstructorBypasses(): string[] {
  const root = path.join(REPO_ROOT, 'apps/api/src');
  const findings: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(filename);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.spec.ts')) {
        continue;
      }
      const relative = path.relative(REPO_ROOT, filename).replace(/\\/g, '/');
      if (relative === 'apps/api/src/engagement/engagement.module.ts') continue;
      if (/new\s+EngagementAiService\s*\(/.test(readFileSync(filename, 'utf8'))) {
        findings.push(relative);
      }
    }
  };
  walk(root);
  return findings;
}

describe('Engagement AI runtime boundary', () => {
  it('covers every public provider-capable AI entry point discovered from the class', () => {
    expect(Object.keys(guardedEngagementAiMethods()).sort()).toEqual(
      providerCapablePublicMethods(),
    );
  });

  it('allows no production constructor bypass outside the guarded module factory', () => {
    expect(productionConstructorBypasses()).toEqual([]);
  });

  it.each(Object.keys(guardedEngagementAiMethods()))(
    'blocks %s before the underlying implementation runs',
    (methodName) => {
      const implementation = jest.fn(async () => ({ ok: true }));
      const raw = {
        [methodName]: implementation,
      } as unknown as EngagementAiService;
      const guarded = guardEngagementAiService(raw, shadowPolicy()) as unknown as Record<
        string,
        (...args: unknown[]) => unknown
      >;

      let caught: unknown;
      try {
        void guarded[methodName]?.({});
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ServiceUnavailableException);
      expect((caught as ServiceUnavailableException).getStatus()).toBe(503);
      expect((caught as ServiceUnavailableException).getResponse()).toMatchObject({
        code: 'ENGAGEMENT_EXTERNAL_ACTION_DISABLED',
      });
      expect(implementation).not.toHaveBeenCalled();
    },
  );

  it('leaves non-provider methods callable', () => {
    const capabilities = jest.fn(() => ({ enabled: false }));
    const raw = { capabilities } as unknown as EngagementAiService;
    const guarded = guardEngagementAiService(raw, shadowPolicy());

    expect(guarded.capabilities()).toEqual({ enabled: false });
    expect(capabilities).toHaveBeenCalledTimes(1);
  });
});
