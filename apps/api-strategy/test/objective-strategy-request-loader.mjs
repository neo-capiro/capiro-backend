// Load the actual private shared contracts for source-only Node harnesses.
// No hash, parser, owner or authority implementation is recreated here.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';

const data = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const custody = [];
async function sourceModule(relative) {
  const path = new URL(relative, import.meta.url), raw = await readFile(path, 'utf8');
  const transformed = stripTypeScriptTypes(raw, { mode: 'strip', sourceUrl: path.href });
  custody.push(Object.freeze({ path: relative,
    rawSha256: createHash('sha256').update(raw).digest('hex'),
    transformedSha256: createHash('sha256').update(transformed).digest('hex') }));
  // Node 22.23.3 strips these pure source files directly. File URLs keep each
  // module's identity stable without embedding its bytes in every transitive
  // data-URL import of the existing service harnesses.
  return path.href;
}

export const objectiveStrategyIntakeUrl = await sourceModule('../../../packages/shared/src/objective-strategy-intake.ts');
const materializationUrl = await sourceModule('../../../packages/shared/src/objective-planner-materialization.ts');
const applicationUrl = await sourceModule('../../../packages/shared/src/objective-planner-application.ts');
export const objectivePlannerOwnerCodecUrl = data(`export * from ${JSON.stringify(materializationUrl)}; export * from ${JSON.stringify(applicationUrl)};`);
export const privateSharedSourceCustody = Object.freeze(custody);
