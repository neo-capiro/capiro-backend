// Load the actual private shared contracts for source-only Node harnesses.
// No hash, parser, owner or authority implementation is recreated here.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';

const data = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const custody = [];
async function sourceModule(relative, replacements = []) {
  const path = new URL(relative, import.meta.url), raw = await readFile(path, 'utf8');
  let source = raw;
  for (const [from, to] of replacements) source = source.replaceAll(from, JSON.stringify(to));
  const transformed = stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: path.href });
  custody.push(Object.freeze({ path: relative,
    rawSha256: createHash('sha256').update(raw).digest('hex'),
    transformedSha256: createHash('sha256').update(transformed).digest('hex') }));
  return data(transformed);
}

const materializationUrl = await sourceModule('../../../packages/shared/src/objective-planner-materialization.ts');
const applicationUrl = await sourceModule('../../../packages/shared/src/objective-planner-application.ts');
export const objectivePlannerOwnerCodecUrl = data(`export * from ${JSON.stringify(materializationUrl)}; export * from ${JSON.stringify(applicationUrl)};`);
const destinationUrl = await sourceModule('../../../packages/shared/src/client-objective-destination.ts');
export const objectiveStrategyIntakeUrl = await sourceModule('../../../packages/shared/src/objective-strategy-intake.ts', [
  ["'./client-objective-destination.js'", destinationUrl],
  ["'./objective-planner-owner-codec.js'", objectivePlannerOwnerCodecUrl],
]);
export const privateSharedSourceCustody = Object.freeze(custody);
