const {default:jest}=require(require.resolve('ts-jest',{paths:["/tmp/capiro-backend-reviewed-receiving-20261013/apps/api"]}));
const delegate=jest.createTransformer({diagnostics:false,isolatedModules:true,tsconfig:{allowJs:true,module:'commonjs',target:'ES2022',esModuleInterop:true}});
module.exports={getCacheKey:(...args)=>delegate.getCacheKey(...args),process:(...args)=>{const value=delegate.process(...args);if(typeof value==='string')return value;return {code:value.code.replace(/\n?\/\/[#@] sourceMappingURL=[^\r\n]*(?:\r?\n)?$/,'')};}};
