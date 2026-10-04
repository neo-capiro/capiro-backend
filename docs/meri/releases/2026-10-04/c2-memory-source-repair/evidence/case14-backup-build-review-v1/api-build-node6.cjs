require('reflect-metadata');
const assert=require('node:assert/strict');
const {MeriController}=require('./dist/meri/meri.controller.js');
const {HTTP_CODE_METADATA,GUARDS_METADATA}=require('@nestjs/common/constants');
assert.equal(Reflect.getMetadata(HTTP_CODE_METADATA,MeriController.prototype.executeTool),200);
const guards=Reflect.getMetadata(GUARDS_METADATA,MeriController.prototype.executeTool);
assert.ok(Array.isArray(guards)&&guards.some(g=>g.name==='ToolServiceSecretGuard'));
console.log('OFFLINE_PACKAGED_C2_TOOL_HTTP_SUCCESS_PASS');
