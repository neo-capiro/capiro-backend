const fs=require('node:fs');
const path=require('node:path');
module.exports=(request,options)=>{
  if(request==='htmlparser2'){
    const direct=/[\\/]apps[\\/]workspace[\\/]src[\\/]newsletters$/.test(options.basedir);
    const resolved=direct
      ?'/tmp/capirov2-workspace-parser-acceptance-cache-20261012/htmlparser2-8.0.2/package/lib/index.js'
      :options.defaultResolver(request,options);
    fs.appendFileSync(path.join(__dirname,'evidence/08-parser-requester-resolution.jsonl'),JSON.stringify({request,basedir:options.basedir,directWorkspace:direct,resolved})+'\n');
    return resolved;
  }
  return options.defaultResolver(request,options);
};
