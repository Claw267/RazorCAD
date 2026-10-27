import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import {KernelClient} from '/js/kernelclient.js';
export async function run({threads=1,requireLifetime=false}={}) {
  const k=new KernelClient({threads}),results=[];
  try {
    await k.ready;
    const initial=await k.request('stats');
    if(requireLifetime&&(!initial.freeing||!initial.stackReset||initial.threads!==threads))return {ok:false,error:'Kernel lifetime, stack or thread initialization failed',initial};
    const d=M.newDoc(), profiles=[];
    const plane=M.createFeature(d,'plane',{refs:[{kind:'plane',id:'top'}],offset:100});d.features.push(plane);
    for(const ref of ['top',plane.id]) {
      const sk=M.createFeature(d,'sketch',{plane:{ref}});
      S.addLine(sk,S.addPoint(sk,-20,0),S.addPoint(sk,20,0));d.features.push(sk);profiles.push(sk.id);
    }
    const guide=M.createFeature(d,'sketch',{plane:{ref:'face',frame:{o:[0,0,0],u:[0,0,1],v:[0,1,0],n:[-1,0,0]}}});
    S.addCtrlSpline(guide,[[0,0],[6,100/3],[6,200/3],[0,100]].map(([x,y])=>S.addPoint(guide,x,y)),3);d.features.push(guide);
    const surface=M.createFeature(d,'surfLoft',{profiles,guides:[guide.id],guideMethod:'constrained',guideContinuity:'G2'});d.features.push(surface);
    const r=await k.rebuild(d);
    results.push({case:'open surface, cubic spline guide',ok:!r.errors.length,errors:r.errors,note:r.notes[surface.id]});
    if(r.errors.length)return {ok:false,results};
    const twin=JSON.parse(JSON.stringify(d)),first=twin.features.find((f)=>f.id===guide.id);
    first.plane.frame.o=[-5,0,0];
    const second=M.createFeature(twin,'sketch',{plane:{ref:'face',frame:{o:[5,0,0],u:[0,0,1],v:[0,1,0],n:[-1,0,0]}}});
    S.addCtrlSpline(second,[[0,0],[-3,100/3],[-3,200/3],[0,100]].map(([x,y])=>S.addPoint(second,x,y)),3);
    const index=twin.features.findIndex((f)=>f.id===surface.id);twin.features.splice(index,0,second);twin.features[index+1].guides=[guide.id,second.id];
    const multiple=await k.rebuild(twin);
    results.push({case:'open surface, two cubic spline guides',ok:!multiple.errors.length&&!!multiple.notes[surface.id]?.includes('G2, 2 seams'),errors:multiple.errors,note:multiple.notes[surface.id]});
    const solid=JSON.parse(JSON.stringify(d));
    for(const id of profiles) {
      const sk=solid.features.find((f)=>f.id===id);sk.points=[];sk.curves=[];
      const points=[[-20,-20],[20,-20],[20,20],[-20,20]].map(([x,y])=>S.addPoint(sk,x,y));points.forEach((p,i)=>S.addLine(sk,p,points[(i+1)%4]));
    }
    const solidGuide=solid.features.find((f)=>f.id===guide.id);solidGuide.plane={ref:'front'};solidGuide.points.forEach((p)=>p.x+=20);
    const boss=solid.features.find((f)=>f.id===surface.id);boss.type='loft';boss.op='add';boss.merge=true;
    const b=await k.rebuild(solid);
    results.push({case:'closed solid, cubic spline guide',ok:!b.errors.length&&!!b.body?.bodies?.some((x)=>x.kind==='solid'),errors:b.errors,note:b.notes[boss.id]});
    if(requireLifetime)for(let i=0;i<4;i++){
      guide.points[1].x+=0.1;const repeated=await k.rebuild(d);
      if(repeated.errors.length)return {ok:false,results,error:'Repeated G2 rebuild failed',errors:repeated.errors};
    }
    const final=await k.request('stats');
    const healthy=!requireLifetime||(final.freeing&&final.stackReset&&final.freed>initial.freed&&final.memoryMB<512&&k.restarts===0);
    return {ok:results.every((x)=>x.ok)&&healthy,results,initial,final,restarts:k.restarts};
  }finally{k.dispose();}
}
