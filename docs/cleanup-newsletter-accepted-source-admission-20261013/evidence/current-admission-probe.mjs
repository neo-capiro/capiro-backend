import { createNewsletterArtifactPackagingPlan } from './backend-source/scripts/lib/newsletter-artifact-packaging-plan.mjs';
const original={standaloneDir:'/synthetic/standalone',publicDir:'/synthetic/public',staticDir:'/synthetic/static',manifestPath:'/synthetic/manifest.json',manifestSha256:'a'.repeat(64),sourceRepository:'neo-capiro/capiro-frontend',sourceCommit:'7c87678730538958ace9762f824dc3e588bf445b',targetPlatform:'linux/amd64',targetLibc:'musl',targetNodeMajor:'24',backendSourceCommit:'9db4e1cd5589a05e08fb88caa38a4ac44937def5',outputDir:'/synthetic/output'};
for(const [name,delta] of [['historical7c',{}],['pendingc8',{sourceCommit:'c8aa693e884de86001d2fc04fbb60d48db09341c'}],['unknownSHA',{sourceCommit:'b'.repeat(40)}],['glibc',{targetLibc:'glibc'}]]) {
  try{const r=createNewsletterArtifactPackagingPlan({...original,...delta});console.log(JSON.stringify({name,accepted:true,assemblyPerformed:r.assemblyPerformed,buildUsedSourceVerified:r.buildUsedSourceVerified,nativeRuntimeCompatibilityVerified:r.nativeRuntimeCompatibilityVerified}));}
  catch(e){console.log(JSON.stringify({name,accepted:false,error:e.message}));}
}
