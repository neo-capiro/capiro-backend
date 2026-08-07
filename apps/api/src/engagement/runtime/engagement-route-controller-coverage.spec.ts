import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const MODULE_FILE = path.join(REPO_ROOT, 'apps/api/src/engagement/engagement.module.ts');
const MANIFEST_FILE = path.join(
  REPO_ROOT,
  'apps/api/src/engagement/__fixtures__/engagement-route-manifest.v1.json',
);

function registeredControllers(): string[] {
  const source = readFileSync(MODULE_FILE, 'utf8');
  const file = ts.createSourceFile(
    MODULE_FILE,
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  const controllers: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name?.text === 'EngagementModule') {
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
                `EngagementModule controllers must stay statically enumerable; found ${element.getText(file)}`,
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

function manifestedControllers(): string[] {
  const manifest = JSON.parse(readFileSync(MANIFEST_FILE, 'utf8')) as {
    routes: Array<{ controller: string }>;
  };
  return [...new Set(manifest.routes.map((route) => route.controller))].sort();
}

describe('Engagement controller discovery coverage', () => {
  it('includes every controller registered by EngagementModule in the route manifest', () => {
    const registered = registeredControllers();
    const manifested = new Set(manifestedControllers());
    expect(registered.length).toBeGreaterThan(0);
    expect(registered.filter((controller) => !manifested.has(controller))).toEqual([]);
  });

  it('contains no unregistered Engagement controller except the intentionally separate Recall webhook', () => {
    const registered = new Set(registeredControllers());
    const extras = manifestedControllers().filter(
      (controller) => !registered.has(controller) && controller !== 'RecallWebhookController',
    );
    expect(extras).toEqual([]);
  });

  it('detects a synthetic newly registered controller missing from the manifest', () => {
    const manifested = new Set(manifestedControllers());
    const syntheticRegistered = [...registeredControllers(), 'FutureEngagementController'];
    expect(syntheticRegistered.filter((controller) => !manifested.has(controller))).toContain(
      'FutureEngagementController',
    );
  });
});
