import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import {KernelClient} from '/js/kernelclient.js';
function fixture({circle=false,diagonal=false,bend=0,length=100,open=false,endRadius=20,surface=false,corner=false}){
  const d=M.newDoc(),profiles=[];
  const plane=M.createFeature(d,'plane',{refs:[{kind:'plane',id:'top'}],offset:length});d.features.push(plane);
  for(const ref of ['top',plane.id]){
    const sk=M.createFeature(d,'sketch',{plane:{ref}});
    if(circle)S.addCircle(sk,'O',ref==='top'?20:endRadius);
    else if(open)S.addLine(sk,S.addPoint(sk,-20,0),S.addPoint(sk,20,0));
    else {const p=[[-20,-20],[20,-20],[20,20],[-20,20]].map(([x,y])=>S.addPoint(sk,x,y));p.forEach((a,i)=>S.addLine(sk,a,p[(i+1)%4]));}
    d.features.push(sk);profiles.push(sk.id);
  }
  const q=Math.SQRT1_2;
  const guide=M.createFeature(d,'sketch',{plane:diagonal?{ref:'face',frame:{o:[0,0,0],u:[q,0,q],v:[0,1,0],n:[-q,0,q]}}:open?{ref:'face',frame:{o:[0,0,0],u:[0,0,1],v:[0,1,0],n:[-1,0,0]}}:corner?{ref:'face',frame:{o:[0,0,-20],u:[1,0,0],v:[0,1,0],n:[0,0,1]}}:{ref:'front'}});
  const start=open?0:20;
  const end=circle?endRadius:start;
  S.addCtrlSpline(guide,[[start,0],[start+(end-start)/3+bend,length/3],[start+2*(end-start)/3-bend,2*length/3],[end,length]].map(([x,y])=>S.addPoint(guide,x,y)),3);d.features.push(guide);
  const loft=M.createFeature(d,(open||surface)?'surfLoft':'loft',{profiles,guides:[guide.id],guideMethod:'constrained',guideContinuity:'G2'});d.features.push(loft);
  return {d,loft,guide};
}
export async function run({threads=1,requireLifetime=false}={}){
  const results=[];
  for(const [name,options] of [
    ['circular straight seam',{circle:true}],
    ['circular curved seam',{circle:true,bend:8}],
    ['circular guide inside quarter arc',{circle:true,diagonal:true,bend:8}],
    ['circular surface with curved guide',{circle:true,surface:true,bend:8}],
    ['tapered circles, straight guide',{circle:true,endRadius:10}],
    ['tight open spline',{open:true,bend:15,length:20}],
    ['tight solid spline',{bend:15,length:20}],
    ['physical corner compatibility',{corner:true,bend:4}],
  ]){
    const k=new KernelClient({threads});let timer;
    try{
      await k.ready;const initial=await k.stats();const {d,loft,guide}=fixture(options),start=performance.now();
      const r=await Promise.race([k.rebuild(d),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Hard-case rebuild exceeded 60 seconds')),60000);})]);
      clearTimeout(timer);
      let measurement;
      if(!r.errors.length&&r.body?.bodies?.length){
        const measured=await k.request('measure',{refs:[{kind:'body',id:r.body.bodies[0].id}]});measurement=measured.items?.[0]||measured;
      }
      let guideError=0;
      if(!r.errors.length){
        const controls=guide.points,point=(t)=>{
          const u=1-t,x=controls[0].x*u**3+3*controls[1].x*u*u*t+3*controls[2].x*u*t*t+controls[3].x*t**3,y=(options.length||100)*t;
          return options.open?[0,y,x]:options.diagonal?[x*Math.SQRT1_2,y,x*Math.SQRT1_2]:[x,y,options.corner?-20:0];
        };
        for(let j=1;j<8;j++){
          const p=point((j+0.31)/9),m=await k.request('measure',{refs:[{kind:'point',p},{kind:(options.open||options.surface)?'edge':'face',p}]});
          if(!Number.isFinite(m.distance))guideError=Infinity;else guideError=Math.max(guideError,m.distance);
        }
      }
      if(options.circle&&!options.bend&&!options.surface&&!options.endRadius){
        const face={kind:'face',p:[20,50,0]},point={kind:'point',p:[25,50,0]};
        const outside=await k.request('measure',{refs:[face,point]});
        if(Math.abs(outside.distance-5)>1e-7)throw new Error('Global distance fallback failed');
        const contact=await k.request('measure',{refs:[face,{kind:'point',p:[20,50,0]}]});
        if(contact.distance>1e-7||Math.abs(contact.b[0]-20)>1e-7)throw new Error('Reversed contact measurement failed');
      }
      const health=await k.stats();
      const item={case:name,ok:!r.errors.length&&!!r.body?.bodies?.length&&health.memoryMB<=512&&guideError<((options.open||options.surface)?1e-8:1e-4),errors:r.errors,note:r.notes[loft.id],health,guideError,ms:Math.round(performance.now()-start)};
      if(measurement){
        item.measurement={area:measurement.area,volume:measurement.volume,solid:measurement.solid};
        item.ok&&=Number.isFinite(measurement.area)&&measurement.area>0;
        if(options.surface||options.open)item.ok&&=!measurement.solid;
        else item.ok&&=measurement.solid&&Number.isFinite(measurement.volume)&&measurement.volume>0;
        if(options.circle&&!options.bend&&!options.surface){
          const radius=options.endRadius||20,volume=Math.PI*100*(400+20*radius+radius*radius)/3;
          item.volumeRelativeError=Math.abs(measurement.volume-volume)/volume;item.ok&&=item.volumeRelativeError<1e-6;
        }
      }
      if(options.corner&&r.errors.length){
        loft.guideContinuity='C0';const recovered=await k.rebuild(d);
        item.explicitRejection=true;item.recoveryErrors=recovered.errors;
        item.ok=!recovered.errors.length&&!!recovered.body?.bodies?.length&&k.restarts===0&&health.stackReset&&health.memoryMB<=512&&r.errors.every(([,m])=>/G2/.test(m));
      }
      item.ok&&=k.restarts===0&&health.stackReset&&(!requireLifetime||(initial.freeing&&health.freeing&&health.freed>initial.freed));
      if(!item.explicitRejection)item.ok&&=/G2, 1 seams/.test(item.note||'')&&Number(item.note?.match(/normal mismatch ([\d.e+\-]+) deg/)?.[1])<=0.5&&Number(item.note?.match(/curvature mismatch ([\d.e+\-]+) 1\/mm/)?.[1])<=0.001;
      results.push(item);console.warn(JSON.stringify(item));
    }catch(e){results.push({case:name,ok:false,error:e.message});console.warn(name+': '+e.message);}
    finally{clearTimeout(timer);k.dispose();}
  }
  const axial=results.find((r)=>r.case==='circular curved seam'),diagonal=results.find((r)=>r.case==='circular guide inside quarter arc');
  const rotational=!!axial?.measurement&&!!diagonal?.measurement&&Math.abs(axial.measurement.volume-diagonal.measurement.volume)/axial.measurement.volume<1e-6&&Math.abs(axial.measurement.area-diagonal.measurement.area)/axial.measurement.area<1e-6;
  return {ok:results.every((r)=>r.ok)&&rotational,rotational,results};
}
