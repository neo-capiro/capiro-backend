const path=require('node:path');
const root=path.resolve(__dirname,'../..');
const base=require(path.join(root,'apps/api/jest.config.cjs'));
module.exports={...base,rootDir:path.join(root,'apps/api'),roots:[path.join(root,'apps/api')],setupFiles:[],setupFilesAfterEnv:[...(base.setupFilesAfterEnv||[]),path.join(__dirname,'source-only-fence.cjs')],cache:false,cacheDirectory:path.join(root,'.qualification-cache/api'),collectCoverage:false};
