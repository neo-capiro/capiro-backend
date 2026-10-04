const { createRequire }=require('node:module');
const api=createRequire('C:/dev/main/meri-c1-20261002/apps/api/package.json');
api('jest').run(['--config',__dirname+'/jest.config.cjs','--runInBand','--no-cache']);
