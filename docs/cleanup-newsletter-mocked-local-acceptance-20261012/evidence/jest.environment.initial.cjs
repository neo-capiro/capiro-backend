const Environment=require('/workspace/capirov2/apps/api/node_modules/jest-environment-node').TestEnvironment;
const net=require('node:net');
class NewsletterMockEnvironment extends Environment {
  async setup(){
    await super.setup();
    for(const name of ['Response','Request','Headers','FormData','Blob','File','AbortController','AbortSignal','ReadableStream','TransformStream','TextDecoder','TextEncoder','URL','URLSearchParams'])if(globalThis[name])this.global[name]=globalThis[name];
    this.global.fetch=()=>Promise.reject(new Error('External transport refused by newsletter mock test host'));
    // Host-only fixture containment: no system/network configuration changes.
    const listen=net.Server.prototype.listen;
    const connect=net.Socket.prototype.connect;
    this.restore=()=>{net.Server.prototype.listen=listen;net.Socket.prototype.connect=connect;};
    net.Server.prototype.listen=function(...args){
      if(typeof args[0]==='number'){
        if(typeof args[1]==='string'&&!['127.0.0.1','::1','localhost'].includes(args[1]))throw Error('Fixture listener must be loopback');
        if(typeof args[1]!=='string')args.splice(1,0,'127.0.0.1');
      }else if(args[0]&&typeof args[0]==='object'){
        const host=args[0].host??'127.0.0.1';
        if(!['127.0.0.1','::1','localhost'].includes(host))throw Error('Fixture listener must be loopback');
        args[0]={...args[0],host};
      }else throw Error('Unrecognized fixture listener');
      return listen.apply(this,args);
    };
    net.Socket.prototype.connect=function(...args){
      const normalized=net._normalizeArgs(args),opts=normalized[0];
      const host=opts.host??'localhost';
      if(opts.path||!['127.0.0.1','::1','localhost'].includes(host))throw Error('External socket refused by newsletter mock test host');
      return connect.apply(this,args);
    };
  }
  async teardown(){this.restore?.();await super.teardown();}
}
module.exports=NewsletterMockEnvironment;
