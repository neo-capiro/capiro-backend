import {registerHooks,createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const cachedApi = createRequire("/workspace/capirov2-reviewed-cleanup-integration-20261013/apps/api/package.json");
globalThis.require=cachedApi;
const aliases=new Map(['@capiro/defense-domain','@capiro/defense-domain/pe-read','@capiro/defense-contracts','@capiro/shared','@capiro/shared/funding-claim'].map(name=>[name,cachedApi.resolve(name)]));
registerHooks({resolve(specifier,context,nextResolve){return nextResolve(aliases.get(specifier)??specifier,context);}});
