import {sample} from "./hidden.cjs";
function withContextRetry(source:any,fn:any,runtime:any){return fn();}
class C {run(){withContextRetry("x",()=>1,this.retryRuntime);return sample();}}
