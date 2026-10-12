import pathlib, subprocess, hashlib, json
root=pathlib.Path(__file__).resolve().parents[3]
packet=pathlib.Path(__file__).resolve().parent
base='62d057b4a17b2c038920f10b93e83e51e46239bc'
prior='d587441261fd356ee5144a8fc29cb2f771d062b8'
published='67fa9255b8a73f489d7a57c8fe270ed6d03fa016'
intel='98397536c3bda66810abc2ca997ad2ff02b76b34'
skeleton='2d88ac7063e0e5b75c0490411a3758cb655beb01'
head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
def git(*args):return subprocess.check_output(['git',*args],cwd=root)
def entries(ref):
    rows={}
    for row in git('ls-tree','-rz',ref).split(b'\0'):
        if row:
            meta,name=row.split(b'\t',1);rows[name.decode()]=meta.decode()
    return rows
left=entries(base);right=entries(head)
component_paths={ref:git('diff','--name-only',prior,ref,'--',':!docs').decode().splitlines() for ref in [intel,skeleton]}
assert len(component_paths[intel])==6 and len(component_paths[skeleton])==3
assert not set(component_paths[intel]) & set(component_paths[skeleton])
source=set(component_paths[intel]+component_paths[skeleton]);assert len(source)==9
changed=[path for path in set(left)|set(right) if not path.startswith('docs/') and left.get(path)!=right.get(path)]
assert set(changed)==source
rows=[]
for ref,paths in component_paths.items():
    for path in paths:
        assert right[path]==entries(ref)[path]==entries(published)[path],path
        data=git('show',head+':'+path)
        rows.append({'path':path,'component':ref,'publishedCode':published,'entry':right[path],'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
pairs=[
 ('apps/api/src/intelligence/__fixtures__/legacy-ui-contracts/IntelligenceMappingsPage.tsx.txt','apps/web/src/pages/settings/IntelligenceMappingsPage.tsx'),
 ('apps/api/src/intelligence/__fixtures__/legacy-ui-contracts/intelligence-mappings-shared.ts.txt','apps/web/src/pages/settings/intelligence-mappings-shared.ts'),
 ('apps/api/src/meri/__fixtures__/legacy-ui-contracts/components/chat/useMeriChatController.ts.txt','apps/web/src/components/chat/useMeriChatController.ts'),
 ('apps/api/src/meri/__fixtures__/legacy-ui-contracts/vnext/shell/AppShellUui/index.tsx.txt','apps/web/src/vnext/shell/AppShellUui/index.tsx'),
 ('apps/api/src/outreach-v3/state/__fixtures__/legacy-ui-contracts/outreach-v3-skeleton-editing.ts.txt','apps/web/src/vnext/pages/engagement/outreach-v3-skeleton-editing.ts')]
for fixture,web in pairs:
    assert git('show',head+':'+fixture)==git('show',base+':'+web)==git('show',head+':'+web)
int_reader='apps/api/src/intelligence/intelligence.mapping-governance.spec.ts'
meri_reader='apps/api/src/meri/meri-stream-launcher.fail-closed.spec.ts'
skel_reader='apps/api/src/outreach-v3/state/outreach-content-skeleton-boundaries.spec.ts'
text=git('show',head+':'+int_reader).decode()
assert text.count('__fixtures__/legacy-ui-contracts/IntelligenceMappingsPage.tsx.txt')==4
assert text.count('__fixtures__/legacy-ui-contracts/intelligence-mappings-shared.ts.txt')==1
inverse=text.replace('__fixtures__/legacy-ui-contracts/IntelligenceMappingsPage.tsx.txt','../../../web/src/pages/settings/IntelligenceMappingsPage.tsx').replace('__fixtures__/legacy-ui-contracts/intelligence-mappings-shared.ts.txt','../../../web/src/pages/settings/intelligence-mappings-shared.ts')
assert inverse.encode()==git('show',base+':'+int_reader)
text=git('show',head+':'+meri_reader).decode()
assert text.count("const WEB_ROOT = join(__dirname, '__fixtures__/legacy-ui-contracts');")==1 and text.count('join(WEB_ROOT, `${rel}.txt`)')==1
inverse=text.replace("const WEB_ROOT = join(__dirname, '__fixtures__/legacy-ui-contracts');","const WEB_ROOT = join(__dirname, '../../../web/src');").replace('join(WEB_ROOT, `${rel}.txt`)','join(WEB_ROOT, rel)')
assert inverse.encode()==git('show',base+':'+meri_reader)
text=git('show',head+':'+skel_reader).decode();after="join(__dirname, '__fixtures__/legacy-ui-contracts/outreach-v3-skeleton-editing.ts.txt')"
before="join(\n      process.cwd(),\n      '..',\n      'web',\n      'src',\n      'vnext',\n      'pages',\n      'engagement',\n      'outreach-v3-skeleton-editing.ts',\n    )"
assert text.count(after)==1 and text.replace(after,before).encode()==git('show',base+':'+skel_reader)
for path,entry in left.items():
    if path not in source:assert right.get(path)==entry,path
schema=[path for path in left if '/migrations/' in path or path.endswith('/schema.prisma')]
assert all(left[path]==right[path] for path in schema)
for ref in [base,intel,skeleton]:assert subprocess.run(['git','merge-base','--is-ancestor',ref,head],cwd=root).returncode==0
receipt={'reviewSource':head,'reviewTree':git('rev-parse',head+'^{tree}').decode().strip(),'baseline':base,'baselineSourceEquivalentD587':git('diff','--name-only',prior,base,'--',':!docs').decode()=='','components':component_paths,'exactPublishedCodeBlobsAndModes':rows,'fiveFixtureCurrentWebBytesEqual':True,'threeReaderFullBodyInverseEqual':True,'baselineEntriesOutsideNineExact':len(left)-9+5,'schemaMigrationPathsExact':len(schema),'priorDocsExact':sum(path.startswith('docs/') for path in left),'protectedReportingBodyRead':False,'deniedDetailedReportRead':False,'productionApplicationRuntimeDelta':0,'backendOwnedDataNewPaths':5,'readerOperandOnlyPaths':3,'newStaticControlPaths':1}
(packet/'SOURCE-UNION.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({key:value for key,value in receipt.items() if key not in ['components','exactPublishedCodeBlobsAndModes']}))
