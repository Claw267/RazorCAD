import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import {KernelClient} from '/js/kernelclient.js';
export function fixture(type='sweep',orientation='perpendicular',angle=90){
  const doc=M.newDoc();doc.name='Sweep orientation and twist';
  const profile=M.createFeature(doc,'sketch',{plane:{ref:'top'}});
  const p=[[-5,-3],[5,-3],[5,3],[-5,3]].map(([x,y])=>S.addPoint(profile,x,y));p.forEach((a,i)=>S.addLine(profile,a,p[(i+1)%4]));doc.features.push(profile);
  const path=M.createFeature(doc,'sketch',{plane:{ref:'front'}});S.addLine(path,S.addPoint(path,0,0),S.addPoint(path,0,100));doc.features.push(path);
  const sweep=M.createFeature(doc,type,{profile:profile.id,path:path.id,orientation,twistAngle:angle});doc.features.push(sweep);
  return {doc,profile,path,sweep};
}
const reset=sk=>{sk.points=[];sk.curves=[];sk.constraints=[];};
export async function run({threads=1}={}){
 const k=new KernelClient({threads}),results=[];
 const cases=[
  {name:'solid twist +45 sign',angle:45,volume:6000,probe:[5/Math.sqrt(2),100,-5/Math.sqrt(2)]},
  {name:'solid twist -45 sign',angle:-45,volume:6000,probe:[5/Math.sqrt(2),100,5/Math.sqrt(2)]},
  {name:'solid twist 90',volume:6000,probe:[0,100,-5]},
  {name:'solid twist -90',angle:-90,volume:6000,probe:[0,100,-5]},
  {name:'solid twist 360',angle:360,volume:6000,probe:[5,100,0]},
  {name:'solid twist 720',angle:720,volume:6000,probe:[5,100,0]},
  {name:'solid parallel',orientation:'parallel',volume:6000,probe:[5,100,0]},
  {name:'surface twist',type:'surfSweep',probe:[0,100,-5]},
  {name:'surface parallel',type:'surfSweep',orientation:'parallel',probe:[5,100,0]},
  {name:'curved path twist',volume:2400*Math.PI/2,edit:({path})=>{reset(path);S.addArc(path,S.addPoint(path,-40,0),S.addPoint(path,0,0),S.addPoint(path,-40,40));}},
  {name:'curved path parallel',orientation:'parallel',volume:2400,probe:[-35,40,0],edit:({path})=>{reset(path);S.addArc(path,S.addPoint(path,-40,0),S.addPoint(path,0,0),S.addPoint(path,-40,40));}},
  {name:'surface open profile twist',type:'surfSweep',edit:({profile})=>{profile.curves.splice(1);}},
  {name:'surface curved parallel',type:'surfSweep',orientation:'parallel',edit:({path})=>{reset(path);S.addArc(path,S.addPoint(path,-40,0),S.addPoint(path,0,0),S.addPoint(path,-40,40));}},
  {name:'circular option twist',volume:Math.PI*100,edit:({sweep})=>{sweep.profileType='circle';sweep.diameter=2;}},
  {name:'profile with hole twist',volume:(60-Math.PI)*100,edit:({profile})=>{S.addCircle(profile,'O',1);}},
  {name:'thin twist',edit:({sweep})=>{sweep.thin=true;sweep.thinT=0.5;}},
  {name:'twist cut',volume:34000,edit:({doc,sweep})=>{const sk=M.createFeature(doc,'sketch',{plane:{ref:'top'}});S.buildCenterRect(sk,'O',0,0,10,10);const base=M.createFeature(doc,'extrude',{sketch:sk.id,depth:100});doc.features.unshift(sk,base);sweep.op='cut';}},
  {name:'legacy sweep without options',volume:6000,edit:({sweep})=>{delete sweep.orientation;delete sweep.twistAngle;}},
  {name:'parallel ignores retained twist',orientation:'parallel',angle:'invalid retained expression',volume:6000},
  {name:'twist equation',angle:'45 + 45',volume:6000,probe:[0,100,-5]},
  {name:'nonuniform spline path twist',angle:45,volume:6000,probe:[5*Math.cos(Math.PI/8),50,-5*Math.sin(Math.PI/8)],edit:({path})=>{reset(path);S.addCtrlSpline(path,[[0,0],[0,2],[0,10],[0,100]].map(([x,y])=>S.addPoint(path,x,y)),3);}},
  {name:'helix path twist',edit:({doc,sweep})=>{const sk=M.createFeature(doc,'sketch',{plane:{ref:'top'}});S.addCircle(sk,'O',40);const helix=M.createFeature(doc,'helix',{sketch:sk.id,definedBy:'heightRev',height:100,revolutions:0.25,startAngle:0});doc.features.splice(-1,0,sk,helix);sweep.path=helix.id;sweep.profileType='circle';sweep.diameter=2;}},
  {name:'bounded twist refinement',angle:50000,reject:/refinement limit/},
  {name:'closed twist path rejected',edit:({path})=>{reset(path);S.addCircle(path,'O',40);},reject:/normal plane|open path/},
  {name:'unknown orientation',orientation:'bad',reject:/Select Perpendicular/},
  {name:'cornered path',edit:({path})=>{S.addLine(path,path.curves[0].p2,S.addPoint(path,30,100));},reject:/tangent-continuous/},
 ];
 try{await k.ready;for(const c of cases){
  const data=fixture(c.type,c.orientation,c.angle);c.edit?.(data);const r=await k.rebuild(data.doc),item={case:c.name,ok:false,errors:r.errors};
  if(c.reject)item.ok=r.errors.some(([,m])=>c.reject.test(m));
  else if(!r.errors.length){const b=r.body?.bodies?.[0],m=b&&await k.request('measure',{refs:[{kind:'body',id:b.id}]});item.measure=m?.items?.[0];item.ok=!!b&&item.measure.solid===(data.sweep.type==='sweep');
    if(c.volume)item.ok&&=Math.abs(item.measure.volume-c.volume)<Math.max(.01,c.volume*2e-5);
    if(c.probe){const m=await k.request('measure',{refs:[{kind:'point',p:c.probe},{kind:'face',p:c.probe}]});item.contact=m.distance;item.ok&&=m.distance<1e-4;}
  }results.push(item);
 }const health=await k.stats();return {ok:results.every(x=>x.ok)&&!k.restarts&&health.memoryMB<512,results,health};}finally{k.dispose();}
}
