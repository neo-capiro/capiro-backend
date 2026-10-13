'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {createHost, cacheRequire} = require('./critical-loader.cjs');
const output = process.argv[2];
if (!output || fs.existsSync(output)) throw new Error('Unique owned output required');
const sourceManifest = JSON.parse(fs.readFileSync(path.join(__dirname,'critical-source-sha256.json'),'utf8'));
const sdk = {
  createClerkClient(options) {
    if (options.secretKey !== '') throw new Error('Fixture requires empty SDK config');
    return {sessions:{getSession:async () => {throw new Error('Online session unavailable during preparation');}}};
  },
  verifyToken: async () => {throw new Error('No token verification during preparation');},
};
(async () => {
  const host = createHost({sourceManifest, sdk, fixtureConfig:{NODE_ENV:'test',CLERK_SECRET_KEY:'',CLERK_JWT_ISSUER:'https://fixture.clerk.invalid'}});
  const {Test} = cacheRequire('@nestjs/testing');
  const PrismaService = host.load(path.join(host.API_ROOT,'src/prisma/prisma.service.ts')).PrismaService;
  const builder = Test.createTestingModule({imports:[host.FixturePortsModule,host.AppModule]})
    .overrideProvider(PrismaService).useValue({withSystem(){throw new Error('DB unavailable during preparation');},withTenant(){throw new Error('DB unavailable during preparation');}});
  const module = await builder.compile();
  const MeriService = host.load(path.join(host.API_ROOT,'src/meri/meri.service.ts')).MeriService;
  const {RAW_MERI_SERVICE} = host.load(path.join(host.API_ROOT,'src/meri/meriv3-runtime.proxy.ts'));
  const proxy = module.get(MeriService);
  const raw = module.get(RAW_MERI_SERVICE);
  const controllerClass = host.load(path.join(host.API_ROOT,'src/meri/meri.controller.ts')).MeriController;
  const middlewareClass = host.load(path.join(host.API_ROOT,'src/tenant/tenant-context.middleware.ts')).TenantContextMiddleware;
  const scopeClass = host.load(path.join(host.API_ROOT,'src/context/context-security-scope.service.ts')).ContextSecurityScopeService;
  const receipt = {source:host.SOURCE_HEAD,prepareOnly:true,listen:false,DB:false,
    proxyDistinct:proxy !== raw, rawActual:raw instanceof MeriService,
    methods:{identity:typeof proxy.applicationAuthorityIdentity,context:typeof proxy.applicationAuthorityContext},
    controllerActual:module.get(controllerClass) instanceof controllerClass,
    middlewareActual:module.get(middlewareClass) instanceof middlewareClass,
    securityScopeActual:module.get(scopeClass) instanceof scopeClass,
    sourceReads:host.reads,unrelatedBlockedImports:host.blocked,testOnlyCalls:host.hostCalls};
  fs.writeFileSync(output, JSON.stringify(receipt,null,2)+'\n', {flag:'wx'});
  console.log(JSON.stringify({prepare:'PASS',criticalFiles:host.reads.length,blockedImports:host.blocked.length,proxyDistinct:receipt.proxyDistinct}));
  await module.close();
})().catch(error => {console.error(error.stack);process.exitCode=1;});
