import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import {KernelClient} from '/js/kernelclient.js';
export function fixture({continuity='G0',circle=false,curved=false,merge=false}={}){
  const doc=M.newDoc(),sk=M.createFeature(doc,'sketch',{plane:{ref:curved?'front':'top'}});
  let source,edges;
  if(curved){
    S.addArc(sk,S.addPoint(sk,0,-15),S.addPoint(sk,25,-15),S.addPoint(sk,20,0));
    source=M.createFeature(doc,'surfRevolve',{sketch:sk.id,axis:'v',angle:360});edges=[{p:[20,0,0]}];
  }else{
    S.buildCenterRect(sk,'O',0,0,30,20);
    if(circle){S.addCircle(sk,'O',10);edges=[{p:[10,0,0]}];}
    else{S.buildCenterRect(sk,'O',0,0,10,5);edges=[[10,0,0],[0,0,5],[-10,0,0],[0,0,-5]].map(p=>({p}));}
    source=M.createFeature(doc,'surfPlanar',{sketch:sk.id});
  }
  const patch=M.createFeature(doc,'surfFill',{edges,continuity,merge});doc.features.push(sk,source,patch);
  return {doc,patch,source,sk};
}
export function cylindricalFixture(continuity='G2'){
  const doc=M.newDoc();
  const strip=(lo,hi,angle,rotate=false)=>{
    const sk=M.createFeature(doc,'sketch',{plane:{ref:'front'}});S.addLine(sk,S.addPoint(sk,20,lo),S.addPoint(sk,20,hi));
    const surface=M.createFeature(doc,'surfRevolve',{sketch:sk.id,axis:'v',angle});doc.features.push(sk,surface);
    if(rotate)doc.features.push(M.createFeature(doc,'moveBody',{bodies:[surface.id],rotAxis:'y',angle:270}));
    return surface;
  };
  const source=strip(0,30,270);strip(-5,0,90,true);strip(30,35,90,true);
  const r=Math.sqrt(200),edges=[[20,15,0],[r,30,r],[0,15,20],[r,0,r]].map(p=>({p}));
  const patch=M.createFeature(doc,'surfFill',{edges,continuity,merge:false});doc.features.push(patch);return {doc,patch,source};
}
export function boxFixture({solid=false,open=false,continuity='G0'}={}){
  const doc=M.newDoc(),sk=M.createFeature(doc,'sketch',{plane:{ref:'top'}});S.buildCenterRect(sk,'O',0,0,10,5);
  const source=M.createFeature(doc,open?'surfExtrude':'extrude',{sketch:sk.id,depth:10,merge:false});doc.features.push(sk,source);
  if(solid)doc.features.push(M.createFeature(doc,'deleteFace',{faces:[{p:[0,10,0],n:[0,1,0]}],mode:'delete'}));
  const patch=M.createFeature(doc,'surfFill',{edges:[[10,10,0],[0,10,5],[-10,10,0],[0,10,-5]].map(p=>({p})),continuity,merge:solid,solid});doc.features.push(patch);
  return {doc,patch,source,sk};
}
export async function run({threads=1}={}){
  const kernel=new KernelClient({threads}),results=[];
  const cases=[
    ...['G0','G1','G2'].flatMap(continuity=>[false,true].map(merge=>({name:`planar ${continuity} merge ${merge}`,continuity,merge}))),
    ...['G0','G1','G2'].map(continuity=>({name:`circular ${continuity}`,continuity,circle:true})),
    ...['G0','G1','G2'].map(continuity=>({name:`spherical ${continuity}`,continuity,curved:true})),
    ...['G0','G1','G2'].map(continuity=>({name:`cylindrical ${continuity}`,factory:()=>cylindricalFixture(continuity)})),
    {name:'close a solid cavity',factory:()=>boxFixture({solid:true}),solid:true,volume:2000},
    {name:'ambiguous solid supports rejected',factory:()=>boxFixture({continuity:'G1'}),reject:/support is ambiguous/},
    {name:'explicit solid support',factory:()=>boxFixture({continuity:'G2'}),edit:({patch})=>{patch.supportFaces=[{p:[0,10,0],n:[0,1,0]}];}},
    {name:'incompatible G1 is not downgraded',factory:()=>boxFixture({open:true,continuity:'G1'}),reject:/could not be satisfied|invalid CAD|incompatible tangent planes/},
    {name:'incompatible G2 is not downgraded',factory:()=>boxFixture({open:true,continuity:'G2'}),reject:/could not be satisfied|invalid CAD|incompatible tangent planes/},
    {name:'mixed edge continuity',edit:({patch})=>{patch.edges[0].continuity='G1';patch.edges[1].continuity='G2';}},
    {name:'legacy tangent',edit:({patch})=>{delete patch.continuity;patch.tangent=true;}},
    {name:'open boundary rejected',edit:({patch})=>{patch.edges.pop();},reject:/closed loop|boundary is open/},
    {name:'extra disconnected edge rejected',edit:({patch})=>{patch.edges.push({p:[30,0,0]});},reject:/closed loop|branches|extra loops/},
    {name:'missing boundary edge rejected',edit:({patch})=>{patch.edges[0].p=[9999,9999,9999];},reject:/boundary edge could not be found/},
    {name:'duplicate boundary rejected',edit:({patch})=>{patch.edges.push(structuredClone(patch.edges[0]));},reject:/more than once/},
    {name:'unknown continuity rejected',continuity:'bad',reject:/supported patch continuity/},
    {name:'unknown edge continuity rejected',edit:({patch})=>{patch.edges[1].continuity='bad';},reject:/supported patch edge/},
    {name:'inactive G0 support ignored',edit:({patch})=>{patch.supportFaces=[{body:'missing',p:[15,0,0]}];}},
    {name:'missing support rejected',continuity:'G2',edit:({patch})=>{patch.supportFaces=[{body:'missing',p:[15,0,0]}];},reject:/support face is missing/},
  ];
  try{await kernel.ready;for(const c of cases){
    const data=c.factory?c.factory():fixture(c);c.edit?.(data);const r=await kernel.rebuild(data.doc),note=r.notes[data.patch.id];
    const result={name:c.name,errors:r.errors,note,ok:c.reject?r.errors.some(([,e])=>c.reject.test(e)):!r.errors.length&&note?.includes('CAD contact')};
    if(result.ok&&!c.reject){
      if(note.includes('G2'))result.ok&&=Number(note.match(/curvature mismatch ([\d.e+\-]+)/)?.[1])<=.001;
      const b=c.merge?r.body.bodies[0]:r.body.bodies.find(b=>M.bodyOwner(b.id)===data.patch.id),m=b&&await kernel.request('measure',{refs:[{kind:'body',id:b.id}]});result.measure=m?.items[0];result.ok=!!result.measure&&result.measure.area>0&&result.measure.solid===!!c.solid;if(c.volume)result.ok&&=Math.abs(result.measure.volume-c.volume)<1e-3;}
    results.push(result);
  }const health=await kernel.stats();return {ok:results.every(x=>x.ok)&&!kernel.restarts&&health.memoryMB<512,results,health};}finally{kernel.dispose();}
}
