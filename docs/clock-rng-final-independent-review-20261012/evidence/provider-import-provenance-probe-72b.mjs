import {readFileSync,writeFileSync} from 'node:fs';
import {analyzeTimeSource} from '../../../scripts/check-strategy-time-bypasses.mjs';
const data=JSON.parse(readFileSync('scripts/strategy-time-boundaries.json','utf8'));
const file='apps/api-strategy/src/meri/strategy-time.providers.ts';const actual=readFileSync(file,'utf8');
const source=actual.replace("from '@capiro/shared';", "from './review-noncanonical-time';");
const result=analyzeTimeSource(file,source,data);
const receipt={source:'72b85754840cf73b484631cb27dd73a48c0e68bd',tree:'a638542193201a11c44b5595e45ac96a187e0196',file,mutant:source,analysis:result,unexpectedlyAccepted:result.events.length===0&&result.problems.length===0,mutantsExecuted:false,moduleGraphLoaded:false,nativeAcceptance:false};
writeFileSync('docs/clock-rng-final-independent-review-20261012/evidence/provider-import-provenance-red-72b.json',JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt,null,2));
