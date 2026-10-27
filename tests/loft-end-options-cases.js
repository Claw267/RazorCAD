import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import {KernelClient} from '/js/kernelclient.js';
import {fixture,tangentFixture} from './loft-end-cases.js';
const lineOnly=sk=>{sk.curves.splice(1);sk.constraints=[];};
export function guidedFixture({type='loft',thin=false,hole=false,circle=false,count=2}={}){
 const data=fixture({type,circle,count}),{doc,loft,profiles}=data;
 if(hole)profiles.forEach(sk=>S.addCircle(sk,'O',2));
 loft.thin=thin;loft.thinT=1;
 const guide=M.createFeature(doc,'sketch',{plane:{ref:'front'}});
 S.addCtrlSpline(guide,[[20,0],[20,100/3],[10,200/3],[10,100]].map(([x,y])=>S.addPoint(guide,x,y)),3);
 doc.features.splice(-1,0,guide);loft.guides=[guide.id];loft.guideMethod='adaptive';data.guide=guide;return data;
}
export function thinTangentFixture(){
 const d=fixture({circle:true,start:'tangent'});d.loft.thin=true;d.loft.thinT=1;
 const base=M.createFeature(d.doc,'extrude',{sketch:d.profiles[0].id,depth:20,reverse:true,merge:false,thin:true,thinT:1,thinDir:'one'});
 d.doc.features.splice(2,0,base);d.loft.startFaces=[{p:[21,-10,0],body:base.id},{p:[20,-10,0],body:base.id}];return d;
}
export function guidedCurvatureFixture(){
 const d=guidedFixture();d.guide.points=[];d.guide.curves=[];d.guide.constraints=[];
 S.addCtrlSpline(d.guide,[[20,0],[20,20],[20,40],[10,60],[10,80],[10,100]].map(([x,y])=>S.addPoint(d.guide,x,y)),5);
 const base=M.createFeature(d.doc,'extrude',{sketch:d.profiles[0].id,depth:20,reverse:true,merge:false});
 const cap=M.createFeature(d.doc,'extrude',{sketch:d.profiles.at(-1).id,depth:20,merge:false});
 d.doc.features.splice(2,0,base);d.doc.features.splice(-1,0,cap);
 d.loft.startCondition=d.loft.endCondition='curvature';
 d.loft.startFaces=[[20,-10,0],[-20,-10,0],[0,-10,15],[0,-10,-15]].map(p=>({p}));
 d.loft.endFaces=[[10,110,0],[-10,110,0],[0,110,10],[0,110,-10]].map(p=>({p}));return d;
}
export async function run({threads=1}={}){
 const k=new KernelClient({threads}),results=[];
 const cases=[
  {name:'one hole',hole:true,volume:120000-400*Math.PI,probe:[0,50,0],gap:2},
  {name:'two holes',holes:2,volume:120000-800*Math.PI},
  ...['one','other','mid'].map((dir,i)=>({name:'rectangular Thin '+dir,thin:dir,volume:[14400,13600,14000][i]})),
  ...['one','other','mid'].map((dir,i)=>({name:'circular Thin '+dir,thin:dir,circle:true,volume:[4100,3900,4000][i]*Math.PI})),
  {name:'open profile Thin',thin:'mid',open:true},
  {name:'G1 outer and inner walls',factory:()=>{const d=tangentFixture();d.profiles.forEach(sk=>S.addCircle(sk,'O',2));d.loft.startFaces.push({p:[2,-10,0]});return d;}},
  {name:'G1 Thin inner and outer walls',factory:thinTangentFixture},
  {name:'G2 Thin inner and outer walls',factory:()=>{const d=thinTangentFixture();d.loft.startCondition='curvature';return d;}},
  {name:'G2 outer and inner walls',factory:()=>{const d=tangentFixture();d.profiles.forEach(sk=>S.addCircle(sk,'O',2));d.loft.startCondition='curvature';d.loft.startFaces.push({p:[2,-10,0]});return d;}},
  {name:'guided G2 both ends',factory:guidedCurvatureFixture},
  {name:'guided normal loft',contact:true,factory:()=>guidedFixture()},
  {name:'guided circular loft',factory:()=>guidedFixture({circle:true})},
  {name:'guided loft with a hole',factory:()=>guidedFixture({hole:true})},
  {name:'guided Thin loft',contact:true,outerContact:true,factory:()=>guidedFixture({thin:true})},
  {name:'guide with free start',factory:()=>guidedFixture(),edit:({loft})=>{loft.startCondition='none';}},
  {name:'guide with free end',factory:()=>guidedFixture(),edit:({loft})=>{loft.endCondition='none';}},
  {name:'three guided profiles',factory:()=>guidedFixture({count:3})},
  {name:'two guides and a hole',factory:()=>{const d=guidedFixture({hole:true});const other=M.createFeature(d.doc,'sketch',{plane:{ref:'front'}});S.addCtrlSpline(other,[[-20,0],[-20,100/3],[-10,200/3],[-10,100]].map(([x,y])=>S.addPoint(other,x,y)),3);d.doc.features.splice(-1,0,other);d.loft.guides.push(other.id);return d;}},
  {name:'reverse guide direction',factory:()=>guidedFixture(),edit:({guide})=>{const c=guide.curves[0];c.pts.reverse();c.p1=c.pts[0];c.p2=c.pts.at(-1);}},
  {name:'guided open surface',factory:()=>{const d=guidedFixture({type:'surfLoft'});d.profiles.forEach((sk,i)=>{sk.points=[];sk.curves=[];sk.constraints=[];S.addLine(sk,S.addPoint(sk,-20+10*i,0),S.addPoint(sk,20-10*i,0));});return d;}},
  {name:'guided open Thin',factory:()=>{const d=guidedFixture({thin:true});d.profiles.forEach((sk,i)=>{sk.points=[];sk.curves=[];sk.constraints=[];S.addLine(sk,S.addPoint(sk,-20+10*i,0),S.addPoint(sk,20-10*i,0));});return d;}},
  {name:'guided G1 with outer and inner walls',factory:()=>{const d=guidedFixture({hole:true});const base=M.createFeature(d.doc,'extrude',{sketch:d.profiles[0].id,depth:20,reverse:true,merge:false});d.doc.features.splice(2,0,base);d.loft.startCondition='tangent';d.loft.startFaces=[[20,-10,0],[-20,-10,0],[0,-10,15],[0,-10,-15],[2,-10,0]].map(p=>({p}));return d;}},
  {name:'guided closed surface',factory:()=>guidedFixture({type:'surfLoft'})},
  {name:'guide tangent contradiction',factory:()=>guidedFixture(),edit:({guide})=>{guide.points[1].x=26;},reject:/tangent incompatible/},
  {name:'reverse endpoint conflicts with guide',factory:()=>guidedFixture(),edit:({loft})=>{loft.startReverse=true;},reject:/direction incompatible/},
  {name:'native guide seams explicit',factory:()=>guidedFixture(),edit:({loft})=>{loft.guideMethod='constrained';},reject:/require Adaptive/},
 ];
 try{await k.ready;for(const c of cases){
  const data=c.factory?c.factory():fixture({circle:c.circle}),{loft,profiles}=data;
  if(!c.factory){
   if(c.circle)profiles[1].curves[0].r=20;else profiles[1].points=structuredClone(profiles[0].points);
   if(c.hole)profiles.forEach(sk=>S.addCircle(sk,'O',2));
   if(c.holes)profiles.forEach(sk=>{for(const x of [-8,8])S.addCircle(sk,S.addPoint(sk,x,0),2);});
   if(c.open)profiles.forEach(lineOnly);
   if(c.thin){loft.thin=true;loft.thinDir=c.thin;loft.thinT=1;}
  }
  c.edit?.(data);const r=await k.rebuild(data.doc),item={case:c.name,ok:false,errors:r.errors};
  if(c.reject)item.ok=r.errors.some(([,m])=>c.reject.test(m));
  else if(!r.errors.length){const b=r.body.bodies.at(-1),m=await k.request('measure',{refs:[{kind:'body',id:b.id}]});item.measure=m.items[0];item.note=r.notes[loft.id];item.ok=item.measure.solid===(loft.type==='loft')&&(!item.measure.solid||item.measure.volume>0);
   if(c.volume)item.ok&&=Math.abs(item.measure.volume-c.volume)/c.volume<2e-5;
   if(c.probe){const m=await k.request('measure',{refs:[{kind:'point',p:c.probe},{kind:'face',p:[2,50,0]}]});item.holeGap=m.distance;item.ok&&=Math.abs(m.distance-c.gap)<1e-4;}
   if(c.contact){const p=[18.4375,25,0],m=await k.request('measure',{refs:[{kind:'point',p},{kind:'face',p}]});item.guideContact=m.distance;item.ok&&=m.distance<=1e-4;
    if(c.outerContact){const p=[19.4375,25,0],m=await k.request('measure',{refs:[{kind:'point',p},{kind:'face',p}]});item.outerContact=m.distance;item.ok&&=m.distance<=1e-4;}
   }
  }results.push(item);
 }const health=await k.stats();return {ok:results.every(x=>x.ok)&&!k.restarts&&health.memoryMB<512,results,health};}finally{k.dispose();}
}
