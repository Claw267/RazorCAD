import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import * as LR from '/js/loftrefs.js';
import {KernelClient} from '/js/kernelclient.js';
export function fixture(kind='line'){
  const doc=M.newDoc(),sk=M.createFeature(doc,'sketch',{plane:{ref:'front'}});doc.features.push(sk);
  if(kind==='circle'){S.addCircle(sk,'O',10);S.addLine(sk,S.addPoint(sk,0,-12),S.addPoint(sk,0,12));}
  else{
    S.buildCenterRect(sk,'O',0,0,10,5);
    if(kind==='spline')S.addCtrlSpline(sk,[[-10,0],[-3,3],[3,-3],[10,0]].map(q=>S.addPoint(sk,...q)));
    else if(kind==='bridge'){S.addCircle(sk,'O',2);S.addLine(sk,S.addPoint(sk,2,0),S.addPoint(sk,10,0));}
    else S.addLine(sk,S.addPoint(sk,0,-5),S.addPoint(sk,0,5),kind==='construction');
  }
  return {doc,sk};
}
export async function run({threads=1}={}){
  const kernel=new KernelClient({threads}),results=[];await kernel.ready;
  try{
    for(const kind of ['line','spline','circle','bridge','construction']){
      const {doc,sk}=fixture(kind),regions=LR.selectableRegions(sk),expected=kind==='construction'?[200]:kind==='circle'?[50*Math.PI,50*Math.PI]:kind==='bridge'?[200-4*Math.PI,4*Math.PI]:[100,100];
      if(regions.length!==expected.length){results.push({kind,ok:false,count:regions.length});continue;}
      const refs=regions.map(r=>LR.regionRef(sk.id,r));if(new Set(refs.map(LR.refKey)).size!==refs.length){results.push({kind,ok:false,error:'Distinct faces have duplicate references'});continue;}
      let ok=true;const areas=[];
      for(const ref of refs){
        try{LR.resolveContour(sk,ref);}catch{ok=false;}
        const feature=M.createFeature(doc,'surfPlanar',{profiles:[ref]});doc.features.push(feature);const built=await kernel.rebuild(doc),body=built.body?.bodies?.find(b=>M.bodyOwner(b.id)===feature.id);
        if(built.errors.length||!body){ok=false;areas.push(built.errors);}else areas.push((await kernel.request('measure',{refs:[{kind:'body',id:body.id}]})).items[0].area);doc.features.pop();
      }
      const sorted=areas.slice().sort((a,b)=>a-b),wanted=expected.slice().sort((a,b)=>a-b);ok&&=sorted.every((area,i)=>typeof area==='number'&&Math.abs(area-wanted[i])<.001);
      // Legacy whole-outline references still resolve to their original extent.
      const oldRegion=S.profileRegions(sk,true)[0],legacy={kind:'sketchContour',sketch:sk.id,curves:[...new Set([oldRegion.outer,...oldRegion.holes].flatMap(l=>l.segs.map(g=>g.sourceCurve)))],region:LR.regionKey(oldRegion)};
      try{LR.resolveContour(sk,legacy);}catch{ok=false;}
      const moved=JSON.parse(JSON.stringify(sk));moved.name='Renamed source';moved.points.forEach(p=>{p.x+=7;p.y-=3;});
      // Translate the sketch origin too only for fixtures without origin-based circles.
      if(kind==='line'||kind==='spline'||kind==='construction')for(const ref of refs)try{LR.resolveContour(moved,ref);}catch{ok=false;}
      results.push({kind,ok,areas});
    }
    return {ok:results.every(r=>r.ok),results};
  }finally{kernel.worker.terminate();}
}
