import hashlib
import json
import pathlib
import subprocess

packet=pathlib.Path(__file__).resolve().parent
repo=packet.parents[2]
pin='acf472fe9ffd528eb3088a53c77dae9e01a2f8a2'
source='fe50dc1c2de1660a036e338cf81acdcf0f2fb26a'
def git(*args,cwd=repo):return subprocess.check_output(['git',*args],cwd=cwd)
docpath='docs/contracts/newsletter-outreach-response-routing.md'
doc=git('show',pin+':'+docpath)
prefix='docs/cleanup-outreach-metadata-retirement-contract-audit-20261012/'
binding=json.loads(git('show',pin+':'+prefix+'evidence/READ-BINDINGS.json'))
rows=[]
for row in binding['rows']:
    assert row['path']!='apps/api/src/engagement/engagement.service.ts'
    cwd=repo if row['repository']=='capirov2' else pathlib.Path('/workspace/capiro-frontend')
    data=git('show',row['ref']+':'+row['path'],cwd=cwd)
    assert hashlib.sha256(data).hexdigest()==row['sha256'] and len(data)==row['bytes']
    assert git('rev-parse',row['ref']+':'+row['path'],cwd=cwd).decode().strip()==row['blob']
    rows.append({'repository':row['repository'],'source':row['ref'],'path':row['path'],'sha256':row['sha256']})
owner=git('show',source+':apps/api/src/engagement/newsletter-outreach.service.ts').decode()
for evidence in ["type: 'outbound_campaign'",'newsletterStageId: stage.id','newsletterRevision: stage.revision','[1-5][a-f\\d]{3}-[89ab]', 'AND tenant_id = ${ctx.tenantId}::uuid AND owner_id = ${ctx.clerkUserId}', 'const row = await this.engagement.getOutreachRecord(ctx, id);','const stage = await this.stage(ctx, stageId);','await this.assertClient(ctx, row.clientId);']:
    assert evidence in owner,evidence
probe=json.loads(git('show',pin+':'+prefix+'evidence/frontend-parser-strip-receipt.json'))
assert len(probe['checks'])==4 and all(row['outputMetadataPresent'] is False for row in probe['checks'])
receipt={'acceptedReceivingContractSource':pin,'acceptedReceivingContractTree':git('rev-parse',pin+'^{tree}').decode().strip(),'path':docpath,'bytes':len(doc),'sha256':hashlib.sha256(doc).hexdigest(),'allowedReadBindingsVerified':rows,'readBindingsCount':len(rows),'protectedEngagementServiceBodyRead':False,'existingProducerType':'outbound_campaign','existingMetadataFields':['newsletterStageId','newsletterRevision'],'canonicalStageUuidVersions':'1-5, RFC variant, case insensitive','recordAndStageCurrentAuthoritySourceVerified':True,'metadataIsRoutingHintOnly':True,'savedWsDocVersionBridge':False,'frontendFourProbeMetadataStrippingPreserved':True,'receivingSchemaAndDispatchImplemented':False,'ownerOperationExecuted':False,'effectfulGetExecuted':False}
(packet/'receiving-contract-audit.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({key:value for key,value in receipt.items() if key!='allowedReadBindingsVerified'}))
