import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const MODULES = [
  ['engagement/engagement.module.ts', 'EngagementModule'],
  ['engagement-callbacks/engagement-callbacks.module.ts', 'EngagementCallbacksModule'],
  ['engagement-integrations/engagement-integration-actions.module.ts', 'EngagementIntegrationActionsModule'],
  ['ai-credentials/ai-credentials.module.ts', 'AiCredentialsModule'],
] as const;
const MANIFEST_FILE = path.join(
  REPO_ROOT,
  'apps/api/src/engagement/__fixtures__/engagement-route-manifest.v1.json',
);

function moduleControllers(relativePath: string, moduleName: string): string[] {
  const moduleFile = path.join(REPO_ROOT, 'apps/api/src', relativePath);
  const source = readFileSync(moduleFile, 'utf8');
  const file = ts.createSourceFile(
    moduleFile,
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  const controllers: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name?.text === moduleName) {
      for (const decorator of ts.getDecorators(node) ?? []) {
        const expression = decorator.expression;
        if (!ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression)) continue;
        if (expression.expression.text !== 'Module') continue;
        const metadata = expression.arguments[0];
        if (!metadata || !ts.isObjectLiteralExpression(metadata)) continue;
        for (const property of metadata.properties) {
          if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue;
          if (property.name.text !== 'controllers' || !ts.isArrayLiteralExpression(property.initializer)) {
            continue;
          }
          for (const element of property.initializer.elements) {
            if (!ts.isIdentifier(element)) {
              throw new Error(
                `${moduleName} controllers must stay statically enumerable; found ${element.getText(file)}`,
              );
            }
            controllers.push(element.text);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return controllers.sort();
}

function registeredControllers(): string[] {
  return MODULES.flatMap(([file, name]) => moduleControllers(file, name)).sort();
}

function manifestedControllers(): string[] {
  const manifest = JSON.parse(readFileSync(MANIFEST_FILE, 'utf8')) as {
    routes: Array<{ controller: string }>;
  };
  return [...new Set(manifest.routes.map((route) => route.controller))].sort();
}

describe('Engagement controller discovery coverage', () => {
  it('includes every controller registered by the actual Engagement and callback/action modules', () => {
    const registered = registeredControllers();
    const manifested = new Set(manifestedControllers());
    expect(registered.length).toBeGreaterThan(0);
    expect(registered.filter((controller) => !manifested.has(controller))).toEqual([]);
  });

  it('contains no unregistered Engagement controller except the intentionally separate Recall webhook', () => {
    const registered = new Set(registeredControllers());
    const extras = manifestedControllers().filter(
      (controller) =>
        !registered.has(controller) &&
        controller !== 'RecallWebhookController',
    );
    expect(extras).toEqual([]);
  });

  it('discovers the real split OAuth controllers without a registration exemption', () => {
    expect(moduleControllers(MODULES[1][0], MODULES[1][1])).toEqual(['GoogleCallbacksController', 'MicrosoftCallbacksController']);
    expect(moduleControllers(MODULES[2][0], MODULES[2][1])).toEqual(['GoogleIntegrationActionsController', 'MicrosoftIntegrationActionsController']);
  });

  it('detects a synthetic newly registered controller missing from the manifest', () => {
    const manifested = new Set(manifestedControllers());
    const syntheticRegistered = [...registeredControllers(), 'FutureEngagementController'];
    expect(syntheticRegistered.filter((controller) => !manifested.has(controller))).toContain(
      'FutureEngagementController',
    );
  });
});
