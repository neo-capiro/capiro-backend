const {default:jest}=require(require.resolve('ts-jest',{paths:['/tmp/capiro-backend-reviewed-receiving-20261013/apps/api']}));
const delegate=jest.createTransformer({tsconfig:"/tmp/capiro-backend-reviewed-receiving-20261013/docs/backend-reviewed-receiving-20261013/jest-transform-config.json",diagnostics:false,isolatedModules:true});
module.exports={getCacheKey:(...args)=>delegate.getCacheKey(...args),process:(...args)=>{const value=delegate.process(...args);if(typeof value==='string')return value;return {code:value.code.replace(/\n?\/\/[#@] sourceMappingURL=[^\r\n]*(?:\r?\n)?$/,'')};}};
