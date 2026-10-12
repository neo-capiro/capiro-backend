const path=require('node:path');
const root=path.resolve(__dirname,'../..');
const tokens=path.join(__dirname,'collaborator-tokens.cjs');
const clerkRoot=path.dirname(require.resolve('/workspace/capirov2/apps/api/node_modules/@clerk/backend/package.json'));
module.exports={
  rootDir:root,resolver:path.join(__dirname,'jest.resolver.cjs'),
  testEnvironment:path.join(__dirname,'jest.environment.cjs'),
  testMatch:['<rootDir>/apps/workspace/src/newsletters/*.spec.ts','<rootDir>/apps/api/src/engagement/newsletter-outreach.service.spec.ts','<rootDir>/apps/api/src/workspace-collab/newsletter-*.spec.ts'],
  setupFiles:[],setupFilesAfterEnv:[],maxWorkers:1,
  cacheDirectory:path.join(__dirname,'local-cache'),
  transform:{'^.+\\.ts$':['/workspace/capirov2/apps/api/node_modules/ts-jest',{tsconfig:{module:'CommonJS',target:'ES2022',esModuleInterop:true,experimentalDecorators:true,emitDecoratorMetadata:true,isolatedModules:true},diagnostics:false}]},
  moduleNameMapper:{
    '^sanitize-html$':path.join(__dirname,'native-sanitizer.cjs'),
    '^@capiro/auth$':'<rootDir>/packages/auth/src/current-tenant.decorator.ts',
    '^@capiro/shared/(.*)$':'<rootDir>/packages/shared/src/$1.ts',
    '^(?:\\.\\./prisma/prisma|\\./engagement|\\./outreach-draft|\\./outreach-send-intent|\\./runtime/engagement-runtime-policy|\\.\\./generation/ai-credential|\\.\\./hillday/hillday-source|\\.\\./notifications/notifications|\\.\\./auth/clerk|\\.\\./tenant-admin/tenant-admin|\\.\\./auth/tenant\\.guard)\\.service\\.js$':tokens,
    '^\\.\\./auth/tenant\\.guard\\.js$':tokens,
    '^#crypto$':path.join(clerkRoot,'dist/runtime/node/crypto.js'),
    '^sharp$':require.resolve('/workspace/capirov2/node_modules/.pnpm/sharp@0.35.5_@types+node@26.6.3/node_modules/sharp'),
    '^(\\.{1,2}/.*)\\.js$':'$1',
  },
};
