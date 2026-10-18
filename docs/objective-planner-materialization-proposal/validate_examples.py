"""Offline proposal conformance only; no application/runtime acceptance."""
import copy,json,pathlib
from jsonschema import Draft202012Validator,FormatChecker
p=pathlib.Path(__file__).resolve().parent
s=json.loads((p/'CONTRACT.json').read_text());w=json.loads((p/'WIRE-EXAMPLES.json').read_text())
Draft202012Validator.check_schema(s)
def validator(name):return Draft202012Validator({'$ref':'#/$defs/'+name,'$defs':s['$defs']},format_checker=FormatChecker())
request,response,error=map(validator,['request','response','error'])
def semantic(value):
 tasks=value['tasks'];projects=value['projects'];context=value['context'];excluded=value['exclusions'];counts=value['counts']
 tasknodes={t['sourceNodeId'] for t in tasks};contextnodes={n['sourceNodeId'] for n in context};excludednodes={n['sourceNodeId'] for n in excluded}
 assert len(tasknodes)==len(tasks) and len(contextnodes)==len(context) and len(excludednodes)==len(excluded)
 assert not(tasknodes&contextnodes or tasknodes&excludednodes or contextnodes&excludednodes)
 assert counts==dict(savedNodes=len(tasks)+len(context)+len(excluded),actionableNodes=len(tasks),contextNodes=len(context),archivedNodes=len(excluded),createdProjects=len(projects),createdTasks=len(tasks))
 groupkeys={g['groupKey'] for g in projects};assert len(groupkeys)==len(projects)
 for t in tasks:
  expected={g['groupKey'] for g in projects if t['sourceNodeId'] in g['originalNodeIds']}
  assert set(t['originalGroupKeys'])==expected and expected
  assert set(t['currentGroupKeys'])<=groupkeys
 for g in projects:assert set(g['originalNodeIds'])<=tasknodes
 for rows in (projects,tasks):
  ids=[r['output']['id'] for r in rows if r['output']['id'] is not None];assert len(ids)==len(set(ids))
 unavailable=any(r['output']['availability']!='available' for r in projects+tasks)
 assert (value['status']=='partial')==unavailable
 notices={i['code'] for i in value['issues']}
 if not tasks:assert 'NO_ACTIONABLE_WORK' in notices
 nodes=tasknodes|contextnodes|excludednodes;edges=set();adj={n:[] for n in nodes}
 for e in value['edges']:
  a,b=e['sourceNodeId'],e['dependsOnSourceNodeId'];assert a in nodes and b in nodes and (a,b) not in edges
  edges.add((a,b));adj[a].append(b)
  if e['disposition']=='task_dependency':assert a in tasknodes and b in tasknodes
  if e['disposition']=='context_only':assert a in contextnodes or b in contextnodes
  if e['disposition']=='archived_source':assert a in excludednodes or b in excludednodes
 for n in context:assert all((n['sourceNodeId'],dep) in edges for dep in n['dependsOnSourceNodeIds'])
 visiting=set();done=set()
 def visit(node):
  assert node not in visiting
  if node in done:return
  visiting.add(node)
  for dep in adj[node]:visit(dep)
  visiting.remove(node);done.add(node)
 for node in nodes:visit(node)
count=0
for value in (w['request'],w['multipleGroupRequest']):request.validate(value);count+=1
for value in w['responses'].values():response.validate(value);semantic(value);count+=1
for value in w['errors']:error.validate(value);count+=1
def rejects(v,value):
 global count
 assert list(v.iter_errors(value)),'Invalid proposal fixture was accepted'
 count+=1
bad=copy.deepcopy(w['request']);bad['tenantId']='forged';rejects(request,bad)
bad=copy.deepcopy(w['request']);bad['groups']=[];rejects(request,bad)
bad=copy.deepcopy(w['request']);bad['requestId']='forged';rejects(request,bad)
bad=copy.deepcopy(w['responses']['prepared']);bad['source']['snapshotDigest']='forged';rejects(response,bad)
bad=copy.deepcopy(w['responses']['prepared']);bad['tasks'][0]['output']['availability']='unavailable';rejects(response,bad)
bad=copy.deepcopy(w['responses']['prepared']);bad['issues']=[w['responses']['preparedWithUnsupportedContextDependency']['issues'][0]];rejects(response,bad)
bad=copy.deepcopy(w['responses']['preparedWithUnsupportedContextDependency']);bad['issues']=[];rejects(response,bad)
bad=copy.deepcopy(w['errors'][0]);bad['message']='raw provider stack';rejects(error,bad)
bad=copy.deepcopy(w['errors'][0]);bad['recordedAttempt']=False;rejects(error,bad)
bad=copy.deepcopy(w['errors'][3]);bad['outcome']='unconfirmed';rejects(error,bad)
bad=copy.deepcopy(w['responses']['partialUnavailableOutput']);bad['status']='prepared';rejects(response,bad)
bad=copy.deepcopy(w['responses']['prepared']);bad['status']='partial';rejects(response,bad)
bad=copy.deepcopy(w['responses']['preparedWithUnsupportedContextDependency']);bad['issues']=w['errors'][4]['issues'];rejects(response,bad)
bad=copy.deepcopy(w['responses']['prepared']);bad['counts']['createdTasks']=2
try:semantic(bad);raise RuntimeError('Bad count accepted')
except AssertionError:count+=1
bad=copy.deepcopy(w['responses']['prepared']);bad['tasks'][0]['originalGroupKeys']=['unknown']
try:semantic(bad);raise RuntimeError('Bad group accepted')
except AssertionError:count+=1
print(json.dumps(dict(proposalSchemaChecks=count,passed=True,applicationImplementation=False)))
