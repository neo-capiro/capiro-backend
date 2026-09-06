import { describe, expect, it, jest } from '@jest/globals';
import { scheduleMeriTurnMaintenance } from './meri-turn-maintenance.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const nextImmediate = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('shared Meri after-turn scheduling', () => {
  it('registers the hook as an alias of the existing raw service, avoiding a runtime-proxy cycle', () => {
    const source = ts.createSourceFile(
      'meri.module.ts',
      readFileSync(join(__dirname, 'meri.module.ts'), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const providers: Array<Record<string, string>> = [];
    const visit = (node: ts.Node) => {
      if (ts.isObjectLiteralExpression(node)) {
        const properties = Object.fromEntries(
          node.properties.flatMap((property) =>
            ts.isPropertyAssignment(property)
              ? [[property.name.getText(source), property.initializer.getText(source)]]
              : [],
          ),
        );
        if (properties.provide) providers.push(properties);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(providers).toContainEqual({
      provide: 'MERI_TURN_MAINTENANCE',
      useExisting: 'RAW_MERI_SERVICE',
    });
    expect(providers).toContainEqual({ provide: 'RAW_MERI_SERVICE', useClass: 'MeriService' });
  });

  it('returns the response before maintenance finishes', async () => {
    let finish!: () => void;
    const maintenance = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const onError = jest.fn();
    expect(scheduleMeriTurnMaintenance(maintenance, onError)).toBeUndefined();
    expect(maintenance).not.toHaveBeenCalled();
    await nextImmediate();
    expect(maintenance).toHaveBeenCalledTimes(1);
    finish();
    await nextImmediate();
    expect(onError).not.toHaveBeenCalled();
  });

  it.each(['sync', 'async'])('contains %s maintenance failures after persistence', async (kind) => {
    const error = new Error('summary provider unavailable');
    const onError = jest.fn();
    scheduleMeriTurnMaintenance(() => {
      if (kind === 'sync') throw error;
      return Promise.reject(error);
    }, onError);
    await nextImmediate();
    expect(onError).toHaveBeenCalledWith(error);
  });
});
