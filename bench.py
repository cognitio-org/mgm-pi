#!/usr/bin/env python3
# Usage: python3 bench.py <label> <base_url> <model> [reasoning_effort]
import sys,json,time,urllib.request
label,url,model=sys.argv[1:4]; effort=sys.argv[4] if len(sys.argv)>4 else None
prompt='Write a Python function that parses an ISO-8601 date string and returns a datetime. Include a docstring. Code only.'
body={"model":model,"messages":[{"role":"user","content":prompt}],"stream":True,"max_tokens":400}
if effort: body["reasoning_effort"]=effort
req=urllib.request.Request(url+"/chat/completions",data=json.dumps(body).encode(),headers={"content-type":"application/json","authorization":"Bearer x"})
t0=time.time(); first=None; n=0
for line in urllib.request.urlopen(req, timeout=600):
    line=line.decode().strip()
    if not line.startswith("data:") or line=="data: [DONE]": continue
    d=json.loads(line[5:]).get("choices",[{}])[0].get("delta",{})
    if d.get("content") or d.get("reasoning_content") or d.get("reasoning"):
        if first is None: first=time.time()
        n+=1
t=time.time()
print(f"{label:20s} ttft {first-t0:5.2f}s  gen {n/max(t-first,1e-6):5.1f} tok/s  ({n} tok, {t-t0:.1f}s)")
