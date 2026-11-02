import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import * as ts from 'typescript';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { retireMemberOfficeDraftsInTx } from './member-retention.js';

/** Execute the exact membership-owner methods without constructing provider clients. */
export function memberOwnerFragment(file: string, className: string, methods: readonly string[],
  functions: readonly string[] = []) {
  const source = ts.createSourceFile(file, readFileSync(join(__dirname, '../..', file), 'utf8'),
    ts.ScriptTarget.Latest, true);
  const owner = source.statements.find((node): node is ts.ClassDeclaration =>
    ts.isClassDeclaration(node) && node.name?.text === className);
  const declarations = methods.map(name => {
    const matches = owner?.members.filter(node => ts.isMethodDeclaration(node) && node.name.getText(source) === name);
    if (matches?.length !== 1) throw Error('Expected one canonical membership owner method');
    return matches[0]!.getText(source);
  });
  const helpers = functions.map(name => {
    const matches = source.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (matches.length !== 1) throw Error('Expected one canonical owner helper');
    return matches[0]!.getText(source);
  });
  const sandbox = { BadRequestException, ForbiddenException, NotFoundException, retireMemberOfficeDraftsInTx,
    module: { exports: {} } };
  runInNewContext(ts.transpileModule(`${helpers.join('\n')}
    class Fragment { constructor(dependencies) { Object.assign(this, dependencies); } ${declarations.join('\n')} }
    module.exports = Fragment;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, sandbox);
  return sandbox.module.exports;
}
