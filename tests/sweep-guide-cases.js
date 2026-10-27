import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import {KernelClient} from '/js/kernelclient.js';
export function fixture(mode='contact') {
  const doc=M.newDoc();doc.name='Sweep with path and guide';
  const profile=M.createFeature(doc,'sketch',{plane:{ref:'top'}});S.addCircle(profile,'O',5);doc.features.push(profile);
  const path=M.createFeature(doc,'sketch',{plane:{ref:'front'}});S.addLine(path,S.addPoint(path,0,0),S.addPoint(path,0,100));doc.features.push(path);
  const guide=M.createFeature(doc,'sketch',{plane:{ref:'front'}});S.addLine(guide,S.addPoint(guide,5,0),S.addPoint(guide,10,100));doc.features.push(guide);
  const sweep=M.createFeature(doc,'sweep',{profile:profile.id,path:path.id,guide:guide.id,guideMode:mode});doc.features.push(sweep);
  return {doc,profile,path,guide,sweep};
}
const reset=(sk)=>{sk.points=[];sk.curves=[];sk.constraints=[];};
const simpson=(f,a,b)=>{let sum=f(a)+f(b);for(let i=1;i<2048;i++)sum+=(i%2?4:2)*f(a+(b-a)*i/2048);return sum*(b-a)/6144;};
const cylinder=Math.PI*25*100,cone=Math.PI*100*(25+50+100)/3;
export async function run({threads=1}={}) {
  const k=new KernelClient({threads}),results=[];
  const cases=[
    {name:'orientation, constant diameter',mode:'orientation',expected:cylinder},
    {name:'section size, analytic cone',expected:cone},
    {name:'reverse guide',expected:cone,edit:({guide})=>{const c=guide.curves[0];[c.p1,c.p2]=[c.p2,c.p1];}},
    {name:'nonlinear guide',expected:Math.PI*100*simpson(t=>(5*(1-t)**3+24*(1-t)**2*t+18*(1-t)*t*t+10*t**3)**2,0,1),edit:({guide})=>{reset(guide);S.addCtrlSpline(guide,[[5,0],[8,100/3],[6,200/3],[10,100]].map(([x,y])=>S.addPoint(guide,x,y)),3);}},
    {name:'curved path and varying section',expected:Math.PI*40*simpson(t=>(40-5*Math.cos(t)-Math.sqrt(875+25*Math.cos(t)**2))**2,0,Math.PI/2),edit:({path,guide})=>{
      reset(path);S.addArc(path,S.addPoint(path,-40,0),S.addPoint(path,0,0),S.addPoint(path,-40,40));
      reset(guide);S.addArc(guide,S.addPoint(guide,-35,0),S.addPoint(guide,-5,0),S.addPoint(guide,-40,Math.sqrt(875)));
    }},
    {name:'helical guide rotates rectangular profile',mode:'orientation',expected:6000,probe:[0,100,-5],edit:({doc,profile,sweep})=>{
      reset(profile);const p=[[-5,-3],[5,-3],[5,3],[-5,3]].map(([x,y])=>S.addPoint(profile,x,y));p.forEach((a,i)=>S.addLine(profile,a,p[(i+1)%4]));
      const circle=M.createFeature(doc,'sketch',{plane:{ref:'top'}});S.addCircle(circle,'O',5);
      const helix=M.createFeature(doc,'helix',{sketch:circle.id,definedBy:'heightRev',height:100,revolutions:0.25,startAngle:0});doc.features.splice(-1,0,circle,helix);sweep.guide=helix.id;
    }},
    {name:'circular profile option',expected:cone,edit:({sweep})=>{sweep.profileType='circle';sweep.profile=null;sweep.diameter=10;sweep.thin=true;}},
    {name:'rectangular section scales uniformly',expected:14000,edit:({profile})=>{
      reset(profile);const p=[[-5,-3],[5,-3],[5,3],[-5,3]].map(([x,y])=>S.addPoint(profile,x,y));p.forEach((a,i)=>S.addLine(profile,a,p[(i+1)%4]));
    }},
    {name:'guided sweep cut',expected:Math.PI*400*100-cone,edit:({doc,sweep})=>{
      const base=M.createFeature(doc,'sketch',{plane:{ref:'top'}});S.addCircle(base,'O',20);
      const solid=M.createFeature(doc,'extrude',{sketch:base.id,depth:100});doc.features.unshift(base,solid);sweep.op='cut';
    }},
    {name:'no guide retains legacy sweep',expected:cylinder,edit:({sweep})=>{delete sweep.guide;delete sweep.guideMode;}},
    {name:'guide overrides retained single-path options',expected:cone,edit:({sweep})=>{sweep.orientation='parallel';sweep.twistAngle='invalid retained expression';}},
    {name:'unknown guide mode',reject:/Select Orientation/,edit:({sweep})=>{sweep.guideMode='invalid';}},
    {name:'same path and guide',reject:/different sources/,edit:({sweep})=>{sweep.guide=sweep.path;}},
    {name:'missing guide',reject:/guide is missing/,edit:({sweep})=>{sweep.guide='missing';}},
    {name:'guide does not span path',reject:/normal planes/,edit:({guide})=>{guide.points[1].y=80;}},
    {name:'guide misses profile boundary',reject:/profile boundary/,edit:({guide})=>{guide.points[0].x=6;}},
    {name:'closed guide',reject:/open path and an open guide/,edit:({guide})=>{reset(guide);S.addCircle(guide,'O',5);}},
    {name:'guide crosses path',reject:/crosses|separate|closely|incompatible/,edit:({guide})=>{guide.points[1].x=-5;}},
    {name:'suppressed guide',reject:/guide is missing/,edit:({guide})=>{guide.suppressed=true;}},
    {name:'profile with a hole',reject:/without holes or Thin/,edit:({profile})=>{S.addCircle(profile,'O',2);}},
    {name:'ambiguous normal-plane intersections',reject:/exactly one/,edit:({guide})=>{
      reset(guide);S.addCtrlSpline(guide,[[5,0],[6,200],[9,-100],[10,100]].map(([x,y])=>S.addPoint(guide,x,y)),3);
    }},
    {name:'Thin is explicit',reject:/without holes or Thin/,edit:({sweep})=>{sweep.thin=true;}},
  ];
  try{
    await k.ready;const initial=await k.stats();
    for(const c of cases){
      const data=fixture(c.mode);c.edit?.(data);
      const r=await k.rebuild(data.doc),item={case:c.name,ok:false,errors:r.errors};
      if(c.reject)item.ok=r.errors.some(([,m])=>c.reject.test(m));
      else if(!r.errors.length){
        const body=r.body?.bodies?.[0],m=body&&await k.request('measure',{refs:[{kind:'body',id:body.id}]});
        const volume=m?.items?.[0]?.volume;item.volume=volume;item.expected=c.expected;item.note=r.notes[data.sweep.id];
        item.ok=r.body.bodies.length===1&&body?.kind==='solid'&&Math.abs(volume-c.expected)/c.expected<2e-5;
        if(c.probe){const m=await k.request('measure',{refs:[{kind:'point',p:c.probe},{kind:'face',p:c.probe}]});item.rotationContact=m.distance;item.ok&&=m.distance<1e-4;}
      }
      results.push(item);
    }
    const health=await k.stats();
    return {ok:results.every((x)=>x.ok)&&k.restarts===0&&health.freeing&&health.stackReset&&health.freed>initial.freed&&health.memoryMB<=512,results,health,restarts:k.restarts};
  }finally{k.dispose();}
}
