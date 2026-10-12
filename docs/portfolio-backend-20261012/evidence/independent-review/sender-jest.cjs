const rootDir='/workspace/capirov2-review-sender/apps/api';
const config=require(rootDir+'/jest.config.cjs');
config.rootDir=rootDir;
config.transform['^.+\\.ts$'][1].isolatedModules=true;
module.exports=config;
