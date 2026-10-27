import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import {KernelClient} from '/js/kernelclient.js';
import {fixture as solidFixture} from './sweep-guide-cases.js';
const clear=(sk)=>{sk.points=[];sk.curves=[];sk.constraints=[];};
export function fixture(mode='contact',closed=false){
  const data=solidFixture(mode);data.doc.name='Guided swept surface';data.sweep.type='surfSweep';data.sweep.name='Surface-Sweep1';
  if(!closed){clear(data.profile);S.addLine(data.profile,S.addPoint(data.profile,-5,0),S.addPoint(data.profile,5,0));}
  return data;
}
const simpson=(f,a,b)=>{let sum=f(a)+f(b);for(let i=1;i<2048;i++)sum+=(i%2?4:2)*f(a+(b-a)*i/2048);return sum*(b-a)/6144;};
export async function run({threads=1}={}){
  const k=new KernelClient({threads}),results=[];
  const cases=[
    {name:'open profile, orientation',mode:'orientation',area:1000},
    {name:'open profile, variable section',area:1500},
    {name:'open polyline, variable section',area:3000*Math.sqrt(1.0025),edit:({profile})=>{
      clear(profile);const p=[[5,-5],[5,5],[-5,5]].map(([x,y])=>S.addPoint(profile,x,y));S.addLine(profile,p[0],p[1]);S.addLine(profile,p[1],p[2]);
    }},
    {name:'closed profile, orientation, no caps',closed:true,mode:'orientation',area:1000*Math.PI},
    {name:'closed profile, variable section, no caps',closed:true,area:1500*Math.PI*Math.sqrt(1.0025)},
    {name:'circular profile option, no caps',area:1500*Math.PI*Math.sqrt(1.0025),edit:({sweep})=>{sweep.profileType='circle';sweep.profile=null;sweep.diameter=10;}},
    {name:'reversed guide',area:1500,edit:({guide})=>{const c=guide.curves[0];[c.p1,c.p2]=[c.p2,c.p1];}},
    {name:'nonlinear guide',area:1450,edit:({guide})=>{
      clear(guide);S.addCtrlSpline(guide,[[5,0],[8,100/3],[6,200/3],[10,100]].map(([x,y])=>S.addPoint(guide,x,y)),3);
    }},
    {name:'curved path with variable section',area:80*simpson(t=>40-5*Math.cos(t)-Math.sqrt(875+25*Math.cos(t)**2),0,Math.PI/2),edit:({path,guide})=>{
      clear(path);S.addArc(path,S.addPoint(path,-40,0),S.addPoint(path,0,0),S.addPoint(path,-40,40));
      clear(guide);S.addArc(guide,S.addPoint(guide,-35,0),S.addPoint(guide,-5,0),S.addPoint(guide,-40,Math.sqrt(875)));
    }},
    {name:'legacy surface without guide',area:1000,edit:({sweep})=>{delete sweep.guide;delete sweep.guideMode;}},
    {name:'guide overrides retained single-path options',area:1500,edit:({sweep})=>{sweep.orientation='parallel';sweep.twistAngle='invalid retained expression';}},
    {name:'missing guide',reject:/guide is missing/,edit:({sweep})=>{sweep.guide='missing';}},
    {name:'guide misses profile',reject:/profile curve/,edit:({guide})=>{guide.points[0].x=6;}},
    {name:'guide crosses path',reject:/crosses|separate|closely/,edit:({guide})=>{guide.points[1].x=-5;}},
    {name:'multiple profile chains',reject:/profile must be one connected chain/,edit:({profile})=>{S.addLine(profile,S.addPoint(profile,20,0),S.addPoint(profile,30,0));}},
    {name:'unknown mode',reject:/Select Orientation/,edit:({sweep})=>{sweep.guideMode='unknown';}},
  ];
  try{
    await k.ready;const initial=await k.stats();
    for(const c of cases){
      const data=fixture(c.mode,c.closed);c.edit?.(data);const r=await k.rebuild(data.doc);
      const item={case:c.name,ok:false,errors:r.errors};
      if(c.reject)item.ok=r.errors.some(([,m])=>c.reject.test(m));
      else if(!r.errors.length){
        const body=r.body?.bodies?.[0],m=body&&await k.request('measure',{refs:[{kind:'body',id:body.id}]});
        const info=m?.items?.[0];item.area=info?.area;item.expected=c.area;
        item.ok=r.body.bodies.length===1&&body.kind==='surface'&&!info.solid&&info.volume==null&&Math.abs(info.area-c.area)/c.area<2e-5;
        if(data.sweep.guide&&!r.notes[data.sweep.id]?.includes('Uncapped surface'))item.ok=false;
      }
      results.push(item);
    }
    const health=await k.stats();
    return {ok:results.every((r)=>r.ok)&&!k.restarts&&health.freeing&&health.stackReset&&health.freed>initial.freed&&health.memoryMB<=512,results,health};
  }finally{k.dispose();}
}
