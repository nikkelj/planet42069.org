import json,sys,time,numpy as np
from timed import TimedSim
def load(slug):
    L=json.load(open(f"launches/{slug}.json")); V=json.load(open(f"vehicles/{L['vehicle']}.json")); return V,L
V,L=load("lm3b-calt-validation"); s=TimedSim(V,L); t=time.time()
x0=np.array([V["fit"][p]["x0"] for p in s.free]); r=s.residuals(x0); print("one run",time.time()-t, np.round(r,1))
t=time.time(); x,c=s.solve(); print("fit",time.time()-t,"s cost",c); print(dict(zip(s.free,np.round(x,5))))
r,tab,fin=s.residuals(x,detail=True)
for row in tab: print(row)
print(fin, s.mass_budget())
