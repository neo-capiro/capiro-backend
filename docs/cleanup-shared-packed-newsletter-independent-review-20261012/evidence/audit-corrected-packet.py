import hashlib
import json
import pathlib
import subprocess

packet = pathlib.Path(__file__).resolve().parent
pin = '0180fd0b6564444cf029446cce56da652b1644fb'
initial = '23e3d3a68cf57062482e3cc4ca9b53e9cb249796'
prefix = 'docs/shared-newsletter-packed-distribution-20261012/'
repo = packet.parents[2]
def git(*args): return subprocess.check_output(['git', *args], cwd=repo)
def read(name, ref=pin): return git('show', ref + ':' + prefix + name)
def sha(data): return hashlib.sha256(data).hexdigest()
index = json.loads(read('SHA256-INDEX.json'))
for row in index['files']:
    data = git('show', pin + ':' + row['path'])
    assert len(data) == row['bytes'] and sha(data) == row['sha256'], row['path']
assert set(row['path'] for row in index['files']) | {prefix + 'SHA256-INDEX.json'} == set(git('ls-tree','-r','--name-only',pin,'--',prefix).decode().splitlines())
assert git('show',initial + ':' + prefix + 'SHA256-INDEX.json') == read('evidence/SHA256-INDEX-INITIAL.json')
assert read('artifact/capiro-shared-0.0.0.tgz') == read('artifact/capiro-shared-0.0.0.tgz', initial)
manifest = json.loads(read('PACKED-MANIFEST.json'))
assert manifest['packedEntries'] == json.loads(read('PACKED-MANIFEST.json',initial))['packedEntries']
correction = json.loads(read('NOTIFIER-CORRECTION.json'))
assert correction['initialNoHTTPClaimWithdrawn'] and correction['noGeneralNetworkTraceClaim']
assert 'http fetch GET 200 https://registry.npmjs.org/npm' in read(correction['initialGETLog']).decode()
for item in correction['finalDebugLogs']:
    data=read(item['path']);assert sha(data)==item['sha256']
    assert not any('http fetch' in line for line in data.decode().splitlines())
    assert '"--no-update-notifier"' in data.decode()
    assert 'verbose exit 0' in data.decode()
for item in correction['finalPacks']:
    for flag in ['--offline','--ignore-scripts','--no-update-notifier']:
        assert flag in item['command']
    assert item['command'][item['command'].index('--userconfig')+1] != item['command'][item['command'].index('--globalconfig')+1]
    assert item['exitCode']==0 and item['sha256']==sha(read('artifact/capiro-shared-0.0.0.tgz'))
assert correction['effectiveConfig'] == {'offline':True,'ignoreScripts':True,'updateNotifier':False}
assert read('evidence/notifier-disabled-effective-config.log').decode().splitlines() == ['offline=true','ignore-scripts=true','update-notifier=false']
notifier=pathlib.Path(correction['notifierSource']['path']).read_bytes()
assert sha(notifier)==correction['notifierSource']['sha256']
for path in ['CONSUMER-QUALIFICATION.json','BUILD-RECEIPT.json','evidence/original-C-renderer-golden.json','evidence/packed-renderer-results.json','evidence/browser-renderer-results.json','evidence/browser-metafile.json']:
    assert read(path)==read(path,initial)
assert subprocess.run(['git','merge-base','--is-ancestor',initial,pin],cwd=packet).returncode==0
assert git('diff','--name-only','fe50dc1c2de1660a036e338cf81acdcf0f2fb26a',pin,'--',':!docs').decode()==''
receipt={'acceptedProducerPacket':pin,'acceptedProducerTree':git('rev-parse',pin+'^{tree}').decode().strip(),'initialPacketPreserved':initial,'producerMasterBindingsVerified':len(index['files']),'completeProducerPacketCensus':True,'artifactAndAll182EntryModesBytesUnchanged':True,'allPreviousConsumerResultsExact':True,'initialMetadataGETRetained':True,'initialNoHTTPClaimWithdrawn':True,'finalTwoDebugLogsHttpFetchLines':0,'finalFlagsVerified':['--offline','--ignore-scripts','--no-update-notifier'],'effectiveConfig':correction['effectiveConfig'],'generalProcessNetworkTraceClaim':False,'nonDocDelta':[]}
(packet/'corrected-packet-audit.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(receipt))
