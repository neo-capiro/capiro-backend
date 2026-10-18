/** Explicit generator for the pinned public Meri contract data; no runtime discovery. */
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve,join} from 'node:path';
const sha=value=>createHash('sha256').update(value).digest('hex');
export async function main(args){
 if(args.length===1&&args[0]==='--help'){console.log('Usage: node emit-reader-v2-contract.mjs <Meri checkout root>');return;}
 if(args.length!==1)throw Error('Supply the reviewed Meri contract checkout');
 const source=resolve(args[0]),modulePath=join(source,'packages/contracts/objective-reader-2/schema.mjs');
 const raw=readFileSync(join(source,'packages/contracts/objective-reader-2/reader.schema.json'),'utf8');
 if(sha(raw)!=='d461baaaf2300aa7ffd363bc4b58295d22c437360c126884e96433e10ac16ec1'||
    sha(readFileSync(modulePath))!=='5772f28c5e6e5f5d18d725bf2f12435aad6f1d7a8e2111c6f3bbcdc7a20d8f54')throw Error('Frozen Meri contract bytes differ');
 const {readerPurposes,readerTokenType,readerLimits}=await import(pathToFileURL(modulePath).href);
 const schema=JSON.parse(raw),core=fileURLToPath(new URL('../../../',import.meta.url));
 const output=`/** GENERATED contract data from Meri b2f0a5d71e1c1b6a6cf79b1e9a496ad663ef641a.\n * reader.schema.json SHA256 ${sha(raw)}.\n * Canonical owner: packages/contracts/objective-reader-2. No authority or runtime discovery. */\n`+
  `export const readerPurposes = ${JSON.stringify(readerPurposes,null,2)} as const;\n`+
  `export const readerTokenType = ${JSON.stringify(readerTokenType)} as const;\n`+
  `export const readerLimits = ${JSON.stringify(readerLimits,null,2)} as const;\n`+
  `export const readerStrategyTypes = ${JSON.stringify(schema.$defs.Observation.properties.queuedType.enum)} as const;\n`+
  `export const readerSchema: unknown = ${JSON.stringify(schema,null,2)};\n`;
 writeFileSync(join(core,'apps/api/src/auth/workload-authority/objective-reader-v2-contract.ts'),output);
 console.log(JSON.stringify({schemaSha256:sha(raw),sourceSha256:sha(output)}));
}
if(process.argv[1]===fileURLToPath(import.meta.url))main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
