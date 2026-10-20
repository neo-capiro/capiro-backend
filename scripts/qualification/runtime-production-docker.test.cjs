const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs'),path=require('node:path');
const s=fs.readFileSync(path.resolve(__dirname,'../../apps/api/Dockerfile.alpine-qualification'),'utf8');
const fresh=s.split('FROM base AS production-deps')[1]?.split('# -------- runtime')[0];
test('runtime dependencies come from fresh production stage, retaining Prisma generation',()=>{
 assert.ok(fresh);assert.ok(fresh.includes('pnpm install --frozen-lockfile --prod'));
 assert.ok(fresh.includes('prisma generate'));assert.ok(fresh.includes('PRISMA_CLI_BINARY_TARGETS=linux-musl-arm64-openssl-3.0.x'));
 assert.ok(fresh.includes('/workspace/apps/api/prisma apps/api/prisma'));
 assert.equal(/COPY .*node_modules/.test(fresh),false);
 const copies=s.split('\n').filter(l=>l.startsWith('COPY ')&&l.includes('/workspace/')&&l.includes('/node_modules'));
 assert.equal(copies.length,4);for(const copy of copies)assert.ok(copy.includes('--from=production-deps'));
});
test('all workspace manifests and operational runtime roots remain',()=>{
 for(const p of ['shared','meriv2-core','defense-contracts','defense-domain']){
  assert.ok(fresh.includes('/workspace/packages/'+p+'/package.json'));assert.ok(s.includes('/app/packages/'+p+'/dist'));
 }
 for(const p of ['dist','src','scripts','prisma','data'])assert.ok(s.includes('/workspace/apps/api/'+p+' /app/apps/api/'+p));
 assert.ok(s.includes('CMD ["serve"]'));assert.ok(s.includes('ENTRYPOINT ["/usr/bin/dumb-init", "--", "/usr/local/bin/entrypoint.sh"]'));
});
test('dependency correction preserves both mandatory final qualification gates',()=>{
 assert.ok(s.includes('FROM runtime-base AS runtime'));assert.ok(s.includes('node /qualification/alpine-runtime-probe.cjs --static'));
 assert.ok(s.includes("require('./dist/memory/memory-candidate.service.js')"));assert.equal(s.includes('rm -rf'),false);
});
