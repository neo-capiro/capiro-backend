#!/usr/bin/env python3
from __future__ import annotations
import json, os, re, subprocess, time
from pathlib import Path

env = os.environ.copy()
SHA = "f8dba151c04f334fb81961baa8d67b261b5f6009"
ARN = "arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-api-pe-enrichment:8"
OUT = Path("docs/program-elements/enrichment/batch-logs")
OUT.mkdir(parents=True, exist_ok=True)

def aws(args, raw=False):
    r = subprocess.run(["aws"] + args, capture_output=True, text=True, env=env)
    if r.returncode != 0:
        raise SystemExit((r.stderr or r.stdout)[:3000])
    return r.stdout if raw else json.loads(r.stdout)

net = aws(["ecs","describe-services","--cluster","capiro-dev","--services","capiro-dev-api","--query","services[0].networkConfiguration"])
awsvpc = net["awsvpcConfiguration"]
nc = f"awsvpcConfiguration={{subnets=[{','.join(awsvpc['subnets'])}],securityGroups=[{','.join(awsvpc['securityGroups'])}],assignPublicIp={awsvpc.get('assignPublicIp','DISABLED')}}}"

def run(name, command, polls=300):
    ov = {"containerOverrides":[{"name":"api","command":command,"environment":[{"name":"TMPDIR","value":"/dev/shm"},{"name":"GIT_SHA","value":SHA}]}]}
    p = OUT / f"ov-{name}.json"; p.write_text(json.dumps(ov), encoding="utf-8")
    rt = aws(["ecs","run-task","--cluster","capiro-dev","--task-definition",ARN,"--launch-type","FARGATE","--network-configuration",nc,"--overrides",f"file://{p.resolve()}","--count","1","--started-by",f"pe-{name}"[:36]])
    task = rt["tasks"][0]["taskArn"]
    print(f"\n=== {name} {task}")
    print("CMD", " ".join(command))
    ex=None
    for i in range(polls):
        t=aws(["ecs","describe-tasks","--cluster","capiro-dev","--tasks",task,"--query","tasks[0]"])
        last=t.get("lastStatus"); ex=(t.get("containers") or [{}])[0].get("exitCode")
        if i%5==0 or last=="STOPPED": print(name,"poll",i,last,"exit",ex)
        if last=="STOPPED": break
        time.sleep(8)
    task_id=task.split("/")[-1]; time.sleep(6)
    streams=aws(["logs","describe-log-streams","--log-group-name","/capiro/dev/api","--order-by","LastEventTime","--descending","--max-items","40"])
    text=""
    for s in streams.get("logStreams",[]):
        sn=s.get("logStreamName","")
        if task_id not in sn: continue
        msgs=[]; token=None
        for _ in range(80):
            args=["logs","get-log-events","--log-group-name","/capiro/dev/api","--log-stream-name",sn,"--limit","10000"]
            if not msgs: args+=["--start-from-head"]
            if token: args+=["--next-token", token]
            ev=aws(args); batch=ev.get("events") or []
            if not batch and msgs: break
            msgs.extend(e.get("message","") for e in batch)
            nt=ev.get("nextForwardToken")
            if nt==token: break
            token=nt
        text="\n".join(msgs); (OUT/f"{name}.log").write_text(text, encoding="utf-8"); break
    info={"name":name,"exit":ex,"chars":len(text)}
    for k,pat in [("mode",r'"mode"\s*:\s*"([^"]+)"'),("status",r'"status"\s*:\s*"([^"]+)"'),("upserted",r'"upserted"\s*:\s*(\d+)'),("changed",r'"changed"\s*:\s*(\d+)'),("updated",r'"updated"\s*:\s*(\d+)'),("seen",r'"seen"\s*:\s*(\d+)'),("lines",r'"lines"\s*:\s*(\d+)')]:
        ms=re.findall(pat,text)
        if ms: info[k]=ms[-1]
    print(json.dumps(info)); print("TAIL", text[-700:].replace("\n"," | ")[:700])
    return info

results={}
# pdoc enrichment corrected json if present
pdoc_art="scripts/__data__/corrected_json/pdoc_army_missile_fy2027_corrected.json"
pdoc_sha="a2bf57b27201aa5c71799b1efa8af99f5560962db07e5c21358d9c8da8787f7b"
# inspect then commit via parse-pdoc if that takes artifact, else load-pdoc-enrichment
results["pdoc-json-i"]=run("pdoc-json-i",["parse-pdoc","--artifact",pdoc_art,"--fy","2027"])
if results["pdoc-json-i"].get("exit")==0:
    results["pdoc-json-c"]=run("pdoc-json-c",["parse-pdoc","--artifact",pdoc_art,"--fy","2027","--commit","--approved-sha256",pdoc_sha])
else:
    # try load-pdoc-enrichment path
    results["pdoc-json-i2"]=run("pdoc-json-i2",["load-pdoc-enrichment","--artifact",pdoc_art])
    if results["pdoc-json-i2"].get("exit")==0:
        results["pdoc-json-c"]=run("pdoc-json-c2",["load-pdoc-enrichment","--artifact",pdoc_art,"--commit","--approved-sha256",pdoc_sha])

results["derive"]=run("derive",["run-pe-derive-chain"])
results["diag-final"]=run("diag-final",["diag-pe-trust"], polls=120)

diag={}
log=OUT/"diag-final.log"
if log.exists():
    text=log.read_text(encoding="utf-8", errors="replace")
    s,e=text.find("{"), text.rfind("}")
    if s>=0 and e>s:
        try:
            j=json.loads(text[s:e+1]); pey=j.get("programElementYears",{}); te=j.get("trustEvaluation",{})
            diag={"gitSha":j.get("gitSha"),"trustOk":te.get("ok"),"blockers":[(b.get("code"),b.get("count")) for b in te.get("blockers",[])],"peyTotal":pey.get("total"),"nonNull":pey.get("nonNullByField"),"countByFY":pey.get("countByFiscalYear")}
        except Exception as err:
            diag={"parseError":str(err)}
out={"results":results,"diag":diag}
(OUT/"results-finish.json").write_text(json.dumps(out, indent=2), encoding="utf-8")
print("FINAL", json.dumps(out, indent=2))
