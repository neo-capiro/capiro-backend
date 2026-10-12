/**
 * Source-only containment for the Phase 6 public-law inspection facade.
 *
 * Phase 6 removed this entrypoint's legacy writer. A matching approved SHA can
 * never authorize a commit here. The Phase E inventory still includes the
 * entrypoint, so its verifier must prove that stronger boundary rather than
 * require markers for the removed writer.
 *
 * This closed grammar is verification data, never evaluated as a program.
 * Comments and formatting may change; any executable change requires an
 * explicit review of its containment contract. No artifact is opened here.
 */
import * as ts from 'typescript';

const PERMITTED_FACADE_SOURCE = `
import * as fs from 'node:fs';
import {
  defenseBudgetEnactmentProofV1Schema,
  enactedLineCandidateV1Schema,
} from '../src/defense-budget/stages/enacted/enactment-proof-v1.js';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(\`--\${name}\`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function main(): void {
  if (process.argv.includes('--commit')) {
    throw new Error(
      'parse-defense-approps-public-law: canonical enacted commit is disabled in Phase 6; use proof-gated cycle inspection/certification',
    );
  }
  const proofPath = arg('proof');
  const candidatesPath = arg('candidates');
  if (proofPath == null || candidatesPath == null) {
    throw new Error(
      'Usage: parse:defense-approps-public-law -- --proof <enactment-proof.json> --candidates <line-candidates.json>',
    );
  }
  const proof = defenseBudgetEnactmentProofV1Schema.parse(
    JSON.parse(fs.readFileSync(proofPath, 'utf8')),
  );
  const candidatesRaw = JSON.parse(fs.readFileSync(candidatesPath, 'utf8')) as unknown;
  if (!Array.isArray(candidatesRaw)) throw new Error('candidates file must be an array');
  const candidates = candidatesRaw.map((candidate) => enactedLineCandidateV1Schema.parse(candidate));
  console.log(
    JSON.stringify(
      {
        mode: 'INSPECT_ONLY',
        canonicalWrites: false,
        proofId: proof.proofId,
        publicLawNumber: proof.publicLawNumber,
        proofType: proof.proofType,
        candidateCount: candidates.length,
        next: 'verify the Phase 6 enacted proof chain; no canonical promotion is available here',
      },
      null,
      2,
    ),
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
`;

interface ExecutableShape {
  kind: ts.SyntaxKind;
  value?: string;
  typeOnly?: boolean;
  declarationFlags?: number;
  typeOperator?: ts.SyntaxKind;
  optionalChain?: boolean;
  children: ExecutableShape[];
}

/** Include token values and non-child executable fields; exclude source trivia. */
function executableShape(node: ts.Node): ExecutableShape {
  const shape: ExecutableShape = { kind: node.kind, children: [] };
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) shape.value = node.text;
  else if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) shape.value = node.text;
  else if (ts.isTemplateLiteralToken(node)) shape.value = node.text;
  if (ts.isImportClause(node) || ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) {
    shape.typeOnly = node.isTypeOnly;
  }
  if (ts.isVariableDeclarationList(node)) {
    shape.declarationFlags = node.flags;
  }
  if (ts.isTypeOperatorNode(node)) shape.typeOperator = node.operator;
  if (
    ts.isCallExpression(node) ||
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node)
  ) {
    shape.optionalChain =
      node.questionDotToken != null || (node.flags & ts.NodeFlags.OptionalChain) !== 0;
  }
  ts.forEachChild(node, (child) => {
    shape.children.push(executableShape(child));
  });
  return shape;
}

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile(
    'public-law-facade.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

const permitted = parse(PERMITTED_FACADE_SOURCE);
const statementRoles = [
  'read-only filesystem import',
  'canonical proof and candidate schema imports',
  'read-only argument lookup',
  'inspection main with first unconditional commit refusal, required validation and truthful report',
  'single invocation with nonzero error handling',
] as const;
const permittedStatements = permitted.statements.map((statement) =>
  JSON.stringify(executableShape(statement)),
);

/** Fail closed on any executable divergence from the existing inspection boundary. */
export function publicLawFacadeContainmentFailures(source: string): string[] {
  const actual = parse(source);
  const diagnostics = (actual as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] })
    .parseDiagnostics;
  if (diagnostics.length > 0) return ['public-law facade has invalid TypeScript syntax'];

  const failures: string[] = [];
  if (actual.statements.length !== permittedStatements.length) {
    failures.push('public-law facade contains missing or additional executable statements');
  }
  for (let index = 0; index < permittedStatements.length; index += 1) {
    const statement = actual.statements[index];
    if (
      statement == null ||
      JSON.stringify(executableShape(statement)) !== permittedStatements[index]
    ) {
      failures.push(`public-law facade violates ${statementRoles[index]}`);
    }
  }
  return failures;
}
