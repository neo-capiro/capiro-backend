const path=require('node:path');
const root=path.resolve(__dirname,'../..');
module.exports={
 rootDir:root,testEnvironment:'/workspace/capirov2/node_modules/.pnpm/jest-environment-node@29.7.0/node_modules/jest-environment-node/build/index.js',
 testMatch:['<rootDir>/apps/api/scripts/lib/memory-admin-self-approval-contract.spec.ts','<rootDir>/apps/api/scripts/lib/memory-phase3-review-inbox-contract.spec.ts','<rootDir>/apps/api/src/funding-opportunities/opportunity-explanation.spec.ts'],
 setupFiles:[],setupFilesAfterEnv:[],maxWorkers:1,
 cacheDirectory:'/tmp/capiro-memory-funding-review-cache-20261012',
 transform:{'^.+\\.ts$':['/workspace/capirov2/apps/api/node_modules/ts-jest',{tsconfig:{module:'CommonJS',target:'ES2022',esModuleInterop:true,isolatedModules:true},diagnostics:false}]},
 moduleNameMapper:{'^@capiro/shared$':'<rootDir>/packages/shared/src/index.ts','^(\\.{1,2}/.*)\\.js$':'$1'},
};
