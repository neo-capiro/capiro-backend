const path=require('node:path');const packet=path.resolve(__dirname);
module.exports={...require('./jest.candidate-inert.cjs'),
 moduleNameMapper:{'^@nestjs/common$':path.join(packet,'evidence/inert-nest.cjs'),'^\\.\\./src/cascade/cascade\\.service\\.js$':path.join(packet,'evidence/actual802-cascade.service.ts'),'^\\./cascade\\.config\\.js$':path.join(packet,'evidence/actual802-cascade.config.ts'),'^(\\.{1,2}/.*)\\.js$':'$1'},
 testMatch:['<rootDir>/docs/cleanup-workspace-product-independent-review-20261012/evidence/actual802-cascade.spec.ts']};
