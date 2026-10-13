const node = require("/workspace/capirov2/node_modules/.pnpm/jest-environment-node@29.7.0/node_modules/jest-environment-node/build/index.js");
const sanitize = require(require.resolve('sanitize-html',{paths:["/workspace/capirov2-reviewed-cleanup-integration-20261013/apps/api"]}));
if(typeof sanitize!=='function')throw Error('ACTUAL_SANITIZER_REQUIRED');
module.exports=class extends node.TestEnvironment{async setup(){await super.setup();Object.defineProperty(this.global,'__CAPIRO_JEST_NATIVE_SANITIZE_HTML__',{value:sanitize});}};
