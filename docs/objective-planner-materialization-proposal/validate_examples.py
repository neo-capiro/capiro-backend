"""Offline proposal conformance only; no application/runtime acceptance."""
import copy,json,pathlib
from jsonschema import Draft202012Validator,FormatChecker
p=pathlib.Path(__file__).resolve().parent
s=json.loads((p/'CONTRACT.json').read_text());w=json.loads((p/'WIRE-EXAMPLES.json').read_text())
Draft202012Validator.check_schema(s)
def validator(name):return Draft202012Validator({'$ref':'#/$defs/'+name,'$defs':s['$defs']},format_checker=FormatChecker())
request,response,error=map(validator,['request','response','error'])
count=0
for value in (w['request'],w['multipleGroupRequest']):request.validate(value);count+=1
for value in w['responses'].values():response.validate(value);count+=1
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
print(json.dumps(dict(proposalSchemaChecks=count,passed=True,applicationImplementation=False)))
