import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import * as LR from '/js/loftrefs.js';
import {KernelClient} from '/js/kernelclient.js';
export function fixture({type='revolve',open=false,legacy=false}={}){
  const doc=M.newDoc(),sk=M.createFeature(doc,'sketch',{plane:{ref:'front'}});
  if(open)S.addLine(sk,S.addPoint(sk,15,0),S.addPoint(sk,15,10));
  else{const center=S.addPoint(sk,15,5);S.buildCenterRect(sk,center,15,5,5,5);S.addCircle(sk,S.addPoint(sk,35,5),2);}
  const ref=open?LR.chainRef(sk,sk.id,sk.curves[0].id):LR.regionRef(sk.id,LR.selectableRegions(sk).find(r=>r.outer.segs.length===4));
  const feature=M.createFeature(doc,type,{profiles:[ref],axis:'v',merge:false,depth:10,angle:360});
  if(legacy){delete feature.profiles;delete feature.extent;feature.sketch=sk.id;}
  doc.features.push(sk,feature);return {doc,sk,feature,ref};
}
export function withBase(data){
  const {doc}=data,baseSketch=M.createFeature(doc,'sketch',{plane:{ref:'top'}});S.addCircle(baseSketch,'O',25);
  const base=M.createFeature(doc,'extrude',{sketch:baseSketch.id,depth:10,merge:false});doc.features.splice(-1,0,baseSketch,base);return base;
}
export async function run({threads=1}={}){
  const kernel=new KernelClient({threads}),results=[];
  const cases=[
    {name:'revolve join operation',volume:6250*Math.PI,edit:d=>{withBase(d);d.feature.merge=true;}},
    {name:'revolve new body operation',volume:9250*Math.PI,edit:d=>{withBase(d);d.feature.merge=false;}},
    {name:'revolve cut operation',volume:3250*Math.PI,edit:d=>{withBase(d);d.feature.op='cut';}},
    {name:'selected solid revolve',volume:3000*Math.PI},
    {name:'solid revolve two sides',volume:750*Math.PI,edit:({feature})=>{feature.end='twoSides';feature.angle=60;feature.angle2=30;}},
    {name:'solid revolve symmetric',volume:1500*Math.PI,edit:({feature})=>{feature.end='midplane';feature.angle=180;}},
    {name:'solid revolve reversed',volume:750*Math.PI,edit:({feature})=>{feature.reverse=true;feature.angle=90;}},
    {name:'full ignores inactive angle',volume:3000*Math.PI,edit:({feature})=>{feature.extent='full';feature.angle='inactive';feature.angle2='inactive';}},
    {name:'legacy clamped revolution',legacy:true,volume:3000*Math.PI+280*Math.PI**2,edit:({feature})=>{feature.angle=400;}},
    {name:'axis line survives selected subset',volume:3000*Math.PI,edit:({sk,feature})=>{feature.axis=S.addLine(sk,S.addPoint(sk,0,-10),S.addPoint(sk,0,20),true);}},
    {name:'axis from another sketch',volume:3000*Math.PI,edit:({doc,feature})=>{const axis=M.createFeature(doc,'sketch',{plane:{ref:'front'}});const curve=S.addLine(axis,S.addPoint(axis,0,-10),S.addPoint(axis,0,20),true);doc.features.splice(-1,0,axis);feature.axis='sketchLine';feature.axisSketch={sketch:axis.id,curve};}},
    {name:'project an external axis',volume:3000*Math.PI,edit:({doc,feature})=>{const plane=M.createFeature(doc,'plane',{refs:[{kind:'plane',id:'front'}],offset:5}),axis=M.createFeature(doc,'sketch',{plane:{ref:plane.id}});const curve=S.addLine(axis,S.addPoint(axis,0,-10),S.addPoint(axis,0,20),true);doc.features.splice(-1,0,plane,axis);feature.axis='sketchLine';feature.axisSketch={sketch:axis.id,curve};feature.projectAxis=true;}},
    {name:'thin open revolve',open:true,volume:600*Math.PI,edit:({feature})=>{feature.thin=true;feature.thinT=2;feature.thinDir='mid';}},
    {name:'solid axis crossing rejected',edit:({sk})=>{sk.points.forEach(p=>{p.x-=15;});},reject:/must not cross/},
    {name:'surface axis crossing rejected',type:'surfRevolve',edit:({sk})=>{sk.points.forEach(p=>{p.x-=15;});},reject:/must not cross/},
    {name:'cut without a body rejected',edit:({feature})=>{feature.op='cut';},reject:/existing solid body/},
    {name:'invalid total angle rejected',edit:({feature})=>{feature.end='twoSides';feature.angle=300;feature.angle2=90;},reject:/360/},
    {name:'negative second angle rejected',edit:({feature})=>{feature.end='twoSides';feature.angle=90;feature.angle2=-5;},reject:/nonnegative/},
    {name:'selected surface extrusion',type:'surfExtrude',area:400},
    {name:'legacy surface extrusion',type:'surfExtrude',legacy:true,area:400+40*Math.PI},
    {name:'open surface extrusion',type:'surfExtrude',open:true,area:100},
    {name:'surface extrusion two sides',type:'surfExtrude',area:600,probe:[20,5,-4],edit:({feature})=>{feature.end='twoSides';feature.depth2=5;}},
    {name:'surface extrusion symmetric',type:'surfExtrude',area:400,probe:[20,5,-4],edit:({feature})=>{feature.end='midplane';}},
    {name:'surface extrusion reversed',type:'surfExtrude',area:400,probe:[20,5,-9],edit:({feature})=>{feature.reverse=true;}},
    {name:'inactive second depth ignored',type:'surfExtrude',area:400,edit:({feature})=>{feature.depth2='inactive';}},
    {name:'negative second depth rejected',type:'surfExtrude',edit:({feature})=>{feature.end='twoSides';feature.depth2=-5;},reject:/nonnegative/},
    {name:'selected surface revolution',type:'surfRevolve',area:1200*Math.PI},
    {name:'open surface revolution',type:'surfRevolve',open:true,area:300*Math.PI},
    {name:'surface revolution two sides',type:'surfRevolve',open:true,area:75*Math.PI,edit:({feature})=>{feature.end='twoSides';feature.angle=60;feature.angle2=30;}},
    {name:'surface revolution symmetric',type:'surfRevolve',open:true,area:150*Math.PI,probe:[7.5,5,15*Math.sqrt(3)/2],edit:({feature})=>{feature.end='midplane';feature.angle=180;}},
    {name:'surface revolution reversed',type:'surfRevolve',open:true,area:75*Math.PI,probe:[7.5,5,15*Math.sqrt(3)/2],edit:({feature})=>{feature.reverse=true;feature.angle=90;}},
    {name:'solid extrusion two sides',type:'extrude',volume:1500,edit:({feature})=>{feature.end='twoSides';feature.depth2=5;}},
    {name:'missing selected profile rejected',edit:({feature})=>{feature.profiles=['missing'];},reject:/sketch is missing/},
  ];
  try{await kernel.ready;for(const c of cases){
    const data=fixture(c);c.edit?.(data);const r=await kernel.rebuild(data.doc),item={name:c.name,errors:r.errors,ok:false};
    if(c.reject)item.ok=r.errors.some(([,e])=>c.reject.test(e));
    else if(!r.errors.length){const measurements=[];for(const body of r.body.bodies){const m=await kernel.request('measure',{refs:[{kind:'body',id:body.id}]});measurements.push(m.items[0]);}item.measures=measurements;const key=c.volume?'volume':'area',value=measurements.reduce((s,m)=>s+(m[key]||0),0);item.ok=measurements.length>0&&measurements.every(m=>m.solid===['revolve','extrude'].includes(data.feature.type))&&Math.abs(value-c[key])/c[key]<2e-5;}
    if(item.ok&&c.probe){const m=await kernel.request('measure',{refs:[{kind:'point',p:c.probe},{kind:'face',p:c.probe}]});item.probe=m.distance;item.ok&&=m.distance<=1e-4;}
    results.push(item);
  }const health=await kernel.stats();return {ok:results.every(r=>r.ok)&&!kernel.restarts&&health.memoryMB<512,results,health};}finally{kernel.dispose();}
}
