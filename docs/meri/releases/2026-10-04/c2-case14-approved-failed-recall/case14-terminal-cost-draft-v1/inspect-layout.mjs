import fs from 'node:fs';
const p='C:/dev/main/outputs/meri-c2-20261003/';
const read=x=>JSON.parse(fs.readFileSync(p+x));
const checkpoint=read('case14-live-operator-v1/aggregate-final.json');
const messages=read('case14-terminal-read-v1/messages.json');
const setup=read('case14-live-operator-v1/native-setup-authority-proof.json');
const a=messages.value.find(x=>x.role==='assistant');
console.log(JSON.stringify({checkpointTail:checkpoint.snapshot.runs[checkpoint.snapshot.activeRun],messagesKeys:Object.keys(messages),messageRows:messages.value.map(x=>({keys:Object.keys(x),id:x.id,role:x.role,metadataKeys:Object.keys(x.metadata??{})})),receipt:a.metadata.serverCaptureEvidenceReceipt,authority:a.metadata.case01CaptureAuthority??a.metadata.controlledReadCaptureAuthority??a.metadata,setupKeys:Object.keys(setup.value),resultKeys:Object.keys(setup.value.results),projection:setup.value.results['projection-terminal'],approvalFiles:fs.readdirSync(p+'case14-live-operator-v1/artifacts-ui/case14-approval'),prior24:read('cost-supervised-v1/executed-once/aggregate-checkpoint.json').snapshot.runs['20:f4bb30bb-ebb4-4fba-89a9-d49aeafefd1b']},null,2));
