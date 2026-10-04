const assert=require('node:assert/strict');
const {assertCase12NativeTaskOverrides:check}=require('./dist/meri/meri-case12-native-setup-admission.js');
assert.equal(typeof check,'function');
const expected={containerOverrides:[{name:'api',environment:[{name:'MERI_CASE12_NATIVE_SETUP_INPUT',value:'offline-fixed-input'}]}]};
const actual={...structuredClone(expected),inferenceAcceleratorOverrides:[]};
const before=JSON.stringify(actual);
check(actual,expected);check(expected,expected);assert.equal(JSON.stringify(actual),before);
for(const value of [null,{},'',0,false,[{}],[{deviceName:'unauthorized',deviceType:'eia1.medium'}]])assert.throws(()=>check({...structuredClone(expected),inferenceAcceleratorOverrides:value},expected));
for(const key of ['taskRoleArn','executionRoleArn','cpu','memory','ephemeralStorage','unexpected'])assert.throws(()=>check({...structuredClone(actual),[key]:'unauthorized'},expected));
for(const mutation of [o=>o.containerOverrides[0].command=['node'],o=>o.containerOverrides[0].cpu=1,o=>o.containerOverrides[0].environment.push({name:'UNEXPECTED',value:'x'}),o=>o.containerOverrides[0].environment[0].value='wrong',o=>o.containerOverrides.push({name:'extra'})]){const bad=structuredClone(actual);mutation(bad);assert.throws(()=>check(bad,expected));}
console.log('OFFLINE_PACKAGED_CASE12_ACTUAL_ECS_DEFAULT_PARITY_PASS');
