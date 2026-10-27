import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import {KernelClient} from '/js/kernelclient.js';
export function fixture({type='loft',circle=false,start='normal',end='normal',count=2}={}){
 const doc=M.newDoc(),profiles=[];doc.name='Loft endpoint conditions';
 for(let i=0;i<count;i++){
  const plane=M.createFeature(doc,'plane',{refs:[{kind:'plane',id:'top'}],offset:100*i/(count-1)});doc.features.push(plane);
  const sk=M.createFeature(doc,'sketch',{plane:{ref:plane.id}});
  if(circle)S.addCircle(sk,'O',20-10*i/(count-1));else S.buildCenterRect(sk,'O',0,0,20-10*i/(count-1),15-5*i/(count-1));
  doc.features.push(sk);profiles.push(sk);
 }
 const loft=M.createFeature(doc,type,{profiles:profiles.map(s=>s.id),startCondition:start,endCondition:end,merge:false});doc.features.push(loft);
 return {doc,profiles,loft};
}
export function tangentFixture({cone=false,type='loft'}={}){
 const data=fixture({circle:cone,type,start:'tangent'}),{doc,profiles,loft}=data;
 if(cone){
  const lowerPlane=M.createFeature(doc,'plane',{refs:[{kind:'plane',id:'top'}],offset:-50});
  const lower=M.createFeature(doc,'sketch',{plane:{ref:lowerPlane.id}});S.addCircle(lower,'O',30);
  const base=M.createFeature(doc,'loft',{profiles:[lower.id,profiles[0].id],merge:false});doc.features.splice(2,0,lowerPlane,lower,base);
  loft.startFaces=[{p:[25,-25,0]}];data.supportSketch=lower;data.supportFeature=base;
 }else{
  const base=M.createFeature(doc,'extrude',{sketch:profiles[0].id,depth:20,reverse:true,merge:false});doc.features.splice(2,0,base);
  loft.startFaces=[[20,-10,0],[-20,-10,0],[0,-10,15],[0,-10,-15]].map(p=>({p}));
 }
 return data;
}
// Spherical support has nonzero curvature both along and across the join.
export function curvatureFixture({type='loft',both=false,count=2,torus=false,height=30}={}){
 const data=fixture({type,circle:true,count,start:'curvature'}),{doc,profiles,loft}=data;
 doc.features.filter(f=>f.type==='plane').forEach(f=>{f.offset*=height/100;});
 const support=(side)=>{
  const offset=torus&&!side?30:0,y=side?height:0,r=(side?10:20)+offset,cy=side?height:-15;
  const sk=M.createFeature(doc,'sketch',{plane:{ref:'front'}}),c=S.addPoint(sk,offset,cy);
  if(offset)profiles[0].curves[0].r=r;
  S.addArc(sk,c,S.addPoint(sk,r,y),S.addPoint(sk,side?Math.sqrt(75):25+offset,side?height+5:-15));
  // The lower band must use the short arc from the equator to the join.
  if(!side){const arc=sk.curves[0];[arc.p1,arc.p2]=[arc.p2,arc.p1];}
  const base=M.createFeature(doc,'surfRevolve',{sketch:sk.id,axis:'v',angle:360});doc.features.splice(-1,0,sk,base);
  loft[(side?'end':'start')+'Faces']=[{p:side?[Math.sqrt(100-2.5**2),height+2.5,0]:[offset+Math.sqrt(625-7.5**2),-7.5,0]}];
 };
 support(0);if(both){support(1);loft.endCondition='curvature';}
 return data;
}
export async function run({threads=1}={}){
 const k=new KernelClient({threads}),results=[];
 const cases=[
  {name:'rectangle normal ends'},
  {name:'circle normal ends',circle:true},
  {name:'constant cylinder analytic volume',circle:true,volume:40000*Math.PI,edit:({profiles})=>{profiles[1].curves[0].r=20;}},
  {name:'constant box analytic volume',volume:120000,edit:({profiles})=>{profiles[1].points=structuredClone(profiles[0].points);}},
  {name:'three profiles normal ends',count:3},
  {name:'four profiles normal ends',count:4},
  {name:'five profiles normal ends',count:5},
  {name:'surface normal ends',type:'surfLoft'},
  {name:'open surface normal ends',type:'surfLoft',edit:({profiles})=>{profiles.forEach(s=>{s.curves.splice(1);s.constraints=[];});}},
  {name:'reversed open profile correspondence',sameAs:'open surface normal ends',type:'surfLoft',edit:({profiles})=>{profiles.forEach(s=>{s.curves.splice(1);s.constraints=[];});const c=profiles[1].curves[0];[c.p1,c.p2]=[c.p2,c.p1];}},
  {name:'tilted reference direction',start:'direction',edit:({doc,loft})=>{const sk=M.createFeature(doc,'sketch',{plane:{ref:'front'}});const line=S.addLine(sk,S.addPoint(sk,0,0),S.addPoint(sk,20,100));const axis=M.createFeature(doc,'axis',{axisType:'sketchLine',sketchLine:sk.id+':'+line});doc.features.splice(-1,0,sk,axis);loft.startDirection=axis.id;}},
  {name:'normal start free end',end:'none'},
  {name:'free start normal end',start:'none'},
  {name:'direction',start:'direction',edit:({loft})=>{loft.startDirection='y';}},
  {name:'stronger influence',edit:({loft})=>{loft.startStrength=2;loft.endStrength=.5;}},
  {name:'rectangular adjacent faces G1',factory:()=>tangentFixture()},
  {name:'G1 loft merged into adjacent solid',factory:()=>tangentFixture({cone:true}),bodyCount:1,edit:({loft})=>{loft.merge=true;}},
  {name:'conical adjacent face G1',factory:()=>tangentFixture({cone:true})},
  {name:'surface conical adjacent face G1',factory:()=>tangentFixture({cone:true,type:'surfLoft'})},
  {name:'both endpoint support faces G1',factory:()=>tangentFixture({cone:true}),edit:({doc,profiles,loft})=>{const cap=M.createFeature(doc,'extrude',{sketch:profiles.at(-1).id,depth:20,merge:false});doc.features.splice(-1,0,cap);loft.endCondition='tangent';loft.endFaces=[{p:[10,110,0]}];}},
  {name:'rectangular adjacent faces G2',factory:()=>tangentFixture(),edit:({loft})=>{loft.startCondition='curvature';}},
  {name:'conical adjacent face G2',factory:()=>tangentFixture({cone:true}),edit:({loft})=>{loft.startCondition='curvature';}},
  {name:'surface conical adjacent face G2',factory:()=>tangentFixture({cone:true,type:'surfLoft'}),edit:({loft})=>{loft.startCondition='curvature';}},
  {name:'both endpoint support faces G2',factory:()=>tangentFixture({cone:true}),edit:({doc,profiles,loft})=>{const cap=M.createFeature(doc,'extrude',{sketch:profiles.at(-1).id,depth:20,merge:false});doc.features.splice(-1,0,cap);loft.startCondition=loft.endCondition='curvature';loft.endFaces=[{p:[10,110,0]}];}},
  {name:'mixed G1 start G2 end',factory:()=>tangentFixture({cone:true}),edit:({doc,profiles,loft})=>{const cap=M.createFeature(doc,'extrude',{sketch:profiles.at(-1).id,depth:20,merge:false});doc.features.splice(-1,0,cap);loft.endCondition='curvature';loft.endFaces=[{p:[10,110,0]}];}},
  {name:'spherical adjacent face G2',factory:()=>curvatureFixture()},
  {name:'spherical surface G2 both ends',factory:()=>curvatureFixture({type:'surfLoft',both:true})},
  {name:'spherical solid G2 both ends',factory:()=>curvatureFixture({both:true})},
  {name:'spherical G2 three sections',factory:()=>curvatureFixture({both:true,count:3})},
  {name:'toroidal adjacent face G2',factory:()=>curvatureFixture({torus:true})},
  {name:'G2 start free end',factory:()=>curvatureFixture(),edit:({loft})=>{loft.endCondition='none';}},
  {name:'G2 spherical stronger influence',factory:()=>curvatureFixture(),edit:({loft})=>{loft.startStrength=.6;}},
  {name:'collapsed G2 loft rejected',factory:()=>curvatureFixture({both:true,height:100}),reject:/collapses|singular/},
  {name:'G2 without support rejected',start:'curvature',reject:/Select adjacent support/},
  {name:'missing support body',factory:()=>tangentFixture(),edit:({loft})=>{loft.startFaces[0].body='missing';},reject:/support face is missing/},
  {name:'missing adjacent side',factory:()=>tangentFixture(),edit:({loft})=>{loft.startFaces.pop();},reject:/Every endpoint profile edge/},
  {name:'unrelated support',factory:()=>tangentFixture(),edit:({loft})=>{loft.startFaces=[{p:[0,-20,0],n:[0,-1,0]}];},reject:/Every endpoint profile edge/},
  {name:'missing support',start:'tangent',reject:/Select adjacent support/},
  {name:'zero influence',edit:({loft})=>{loft.startStrength=0;},reject:/greater than zero/},
  {name:'ruled rejected',edit:({loft})=>{loft.ruled=true;},reject:/smooth loft/},
  {name:'contradictory guide tangent',edit:({doc,loft})=>{const guide=M.createFeature(doc,'sketch',{plane:{ref:'front'}});S.addLine(guide,S.addPoint(guide,20,0),S.addPoint(guide,10,100));doc.features.splice(-1,0,guide);loft.guides=[guide.id];},reject:/tangent incompatible/},
  {name:'profiles with a through hole',edit:({profiles})=>{profiles.forEach(s=>S.addCircle(s,'O',2));}},
  {name:'Thin with endpoint conditions',edit:({loft})=>{loft.thin=true;}},
  {name:'unknown condition',start:'bad',reject:/supported loft/},
 ];
 try{await k.ready;for(const c of cases){const data=c.factory?c.factory():fixture(c);c.edit?.(data);const r=await k.rebuild(data.doc),item={case:c.name,ok:false,errors:r.errors};
  if(c.reject)item.ok=r.errors.some(([,m])=>c.reject.test(m));
  else if(!r.errors.length){const b=r.body?.bodies?.find(b=>M.bodyOwner(b.id)===data.loft.id)||r.body?.bodies?.at(-1),m=b&&await k.request('measure',{refs:[{kind:'body',id:b.id}]});item.measure=m?.items?.[0];item.note=r.notes[data.loft.id];item.ok=!!b&&item.measure.solid===(data.loft.type==='loft')&&(!item.measure.solid||item.measure.volume>0)&&item.note?.includes('Endpoint CAD constraints');if([data.loft.startCondition,data.loft.endCondition].includes('curvature'))item.ok&&=Number(item.note?.match(/G2 curvature mismatch ([\d.e+\-]+)/)?.[1])<=.001;if(c.bodyCount)item.ok&&=r.body.bodies.length===c.bodyCount;if(c.volume)item.ok&&=Math.abs(item.measure.volume-c.volume)/c.volume<1e-5;if(c.sameAs){const other=results.find(x=>x.case===c.sameAs);item.ok&&=Math.abs(item.measure.area-other.measure.area)<1e-5;}}
  results.push(item);
 }const health=await k.stats();return {ok:results.every(x=>x.ok)&&!k.restarts&&health.memoryMB<512,results,health};}finally{k.dispose();}
}
