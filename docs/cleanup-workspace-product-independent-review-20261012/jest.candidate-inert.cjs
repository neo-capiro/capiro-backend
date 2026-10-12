const path=require('node:path');
module.exports={rootDir:path.resolve(__dirname,'../..'),testEnvironment:'/workspace/capirov2/node_modules/.pnpm/jest-environment-node@29.7.0/node_modules/jest-environment-node/build/index.js',
 moduleDirectories:['/workspace/capirov2/apps/api/node_modules','/workspace/capirov2/node_modules','node_modules'],
 moduleNameMapper:{'^@nestjs/common$':path.join(__dirname,'evidence/inert-nest.cjs'),'^(\\.{1,2}/.*)\\.js$':'$1'},
 transform:{'^.+\\.ts$':['/workspace/capirov2/apps/api/node_modules/ts-jest',{diagnostics:false,tsconfig:{target:'ES2022',module:'CommonJS',moduleResolution:'Node',esModuleInterop:true,isolatedModules:true,experimentalDecorators:true}}]},
 testMatch:['<rootDir>/apps/workspace/test/product-registry-characterization.spec.ts','<rootDir>/apps/workspace/test/cascade.spec.ts'],cacheDirectory:'/tmp/capiro-workspace-product-independent-jest-cache'};
