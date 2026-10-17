const path=require('node:path');
const root=path.resolve(__dirname,'../../..');
const resolve=name=>require.resolve(name,{paths:[path.join(root,'apps/api')]});
module.exports={rootDir:root,testEnvironment:'node',
 testMatch:['<rootDir>/apps/api-strategy/src/meri/objective-canonical-reader-v2-receiving.spec.ts'],
 transform:{'^.+\\.ts$':[resolve('ts-jest'),{tsconfig:{target:'ES2022',module:'CommonJS',esModuleInterop:true,experimentalDecorators:true,isolatedModules:true},diagnostics:false}]},
 moduleNameMapper:{'^(\\.{1,2}/.*)\\.js$':'$1','^@capiro/shared/objective-planner-owner-codec$':'<rootDir>/packages/shared/src/objective-planner-owner-codec.ts'},
 cache:false,maxWorkers:1};
