import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import * as LR from '/js/loftrefs.js';
import {KernelClient} from '/js/kernelclient.js';
import {boxFixture,cylindricalFixture} from './surface-patch-cases.js';
export function fixture({hole=false,legacy=false}={}){
  const doc=M.newDoc(),sk=M.createFeature(doc,'sketch',{plane:{ref:'top'}});
  S.buildCenterRect(sk,'O',0,0,10,5);S.addCircle(sk,S.addPoint(sk,30,0),3);
  if(hole)S.addCircle(sk,'O',2);
  const regions=LR.selectableRegions(sk),rectangle=regions.find(r=>r.outer.segs.length===4);
  const planar=M.createFeature(doc,'surfPlanar',legacy?{sketch:sk.id}:{profiles:[LR.regionRef(sk.id,rectangle)]});
  if(legacy){delete planar.profiles;delete planar.edges;delete planar.chainSelection;}
  doc.features.push(sk,planar);return {doc,sk,planar,rectangle};
}
export function edgeFixture({curved=false}={}){
  const data=curved?cylindricalFixture():boxFixture(),{doc,patch}=data;
  doc.features=doc.features.filter(f=>f!==patch);
  const planar=M.createFeature(doc,'surfPlanar',{profiles:[],edges:patch.edges});doc.features.push(planar);return {...data,planar};
}
export async function run({threads=1}={}){
  const kernel=new KernelClient({threads}),results=[];
  const cases=[
    {name:'only selected rectangular region',area:200},
    {name:'selected rectangle with a hole',hole:true,area:200-4*Math.PI},
    {name:'legacy whole sketch',legacy:true,area:200+9*Math.PI},
    {name:'whole sketch explicit source',area:200+9*Math.PI,edit:({planar,sk})=>{planar.profiles=[sk.id];}},
    {name:'two selected regions',area:200+9*Math.PI,edit:({planar,sk})=>{planar.profiles=LR.selectableRegions(sk).map(r=>LR.regionRef(sk.id,r));}},
    {name:'individual rectangle entities',area:200,edit:({planar,sk})=>{planar.profiles=[{kind:'sketchContour',sketch:sk.id,curves:sk.curves.slice(0,4).map(c=>c.id)}];}},
    {name:'selected region follows dimensional edit',area:240,edit:({sk})=>{sk.points.forEach(p=>{if(Math.abs(p.x)===10)p.x*=1.2;});}},
    {name:'hole follows dimensional edit',hole:true,area:200-9*Math.PI,edit:({sk})=>{sk.curves.find(c=>c.type==='circle'&&c.r===2).r=3;}},
    {name:'unselected open geometry ignored',area:200,edit:({sk})=>{S.addLine(sk,S.addPoint(sk,50,0),S.addPoint(sk,60,0));}},
    {name:'construction geometry ignored',area:200,edit:({sk})=>{S.addLine(sk,S.addPoint(sk,-20,0),S.addPoint(sk,20,0),true);}},
    {name:'deleted selected curve rejected',edit:({sk})=>{sk.curves.splice(0,1);},reject:/selected curve was deleted/},
    {name:'open entity chain rejected',edit:({planar,sk})=>{planar.profiles=[{kind:'sketchContour',sketch:sk.id,curves:sk.curves.slice(0,3).map(c=>c.id)}];},reject:/closed contour/},
    {name:'missing sketch rejected',edit:({planar})=>{planar.profiles=['missing'];},reject:/sketch is missing/},
    {name:'no arbitrary sketch chosen',edit:({planar})=>{planar.profiles=[];},reject:/Select closed sketch profiles/},
    {name:'model rectangle',factory:edgeFixture,area:200},
    {name:'open model edges rejected',factory:edgeFixture,edit:({planar})=>{planar.edges.pop();},reject:/closed loop|boundary is open/},
    {name:'nonplanar model loop rejected',factory:()=>edgeFixture({curved:true}),reject:/coplanar/},
    {name:'duplicate model edge rejected',factory:edgeFixture,edit:({planar})=>{planar.edges.push(structuredClone(planar.edges[0]));},reject:/more than once/},
  ];
  try{await kernel.ready;for(const c of cases){
    const data=c.factory?c.factory():fixture(c);c.edit?.(data);const r=await kernel.rebuild(data.doc),item={name:c.name,errors:r.errors,ok:false};
    if(c.reject)item.ok=r.errors.some(([,e])=>c.reject.test(e));
    else if(!r.errors.length){const body=r.body.bodies.find(b=>M.bodyOwner(b.id)===data.planar.id),measurement=body&&await kernel.request('measure',{refs:[{kind:'body',id:body.id}]});item.measure=measurement?.items[0];item.ok=!!item.measure&&!item.measure.solid&&Math.abs(item.measure.area-c.area)<1e-4;}
    results.push(item);
  }const health=await kernel.stats();return {ok:results.every(x=>x.ok)&&!kernel.restarts&&health.memoryMB<512,results,health};}finally{kernel.dispose();}
}
