const path=require('node:path');
const root=path.resolve(__dirname,'../../..'),api=path.join(root,'apps/api');
module.exports={rootDir:root,testEnvironment:'node',cache:false,maxWorkers:1,
 testMatch:['<rootDir>/apps/api/src/auth/workload-authority/objective-reader-v2-jwt.spec.ts','<rootDir>/apps/api/src/auth/workload-authority/objective-reader-v2-client.spec.ts'],
 transform:{'^.+\\.ts$':[require.resolve('ts-jest',{paths:[api]}),{tsconfig:path.join(__dirname,'reader-v2.tsconfig.json'),diagnostics:true}]},
 moduleNameMapper:{'^(\\.{1,2}/.*)\\.js$':'$1'},
};
