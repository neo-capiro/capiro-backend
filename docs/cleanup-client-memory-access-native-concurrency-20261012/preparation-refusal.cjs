require('../cleanup-client-memory-access-lock-order-20261012/evidence/strict-source-read-refusal.cjs');
const Module=require('node:module');const load=Module._load;
Module._load=function(name,...args){if(name==='pg'||name==='@prisma/client')throw new Error('Preparation refused database/client driver import before any action');return load.call(this,name,...args);};
