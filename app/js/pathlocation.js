// Arc-length locations on analytic/CAD curves. Adaptive quadrature and bounded
// inversion use derivatives, never display polylines or a cubic fit of a NURBS.
const add=(a,b)=>a.map((x,i)=>x+b[i]),sub=(a,b)=>a.map((x,i)=>x-b[i]),mul=(a,k)=>a.map(x=>x*k),norm=a=>Math.hypot(...a),dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0);
const unit=a=>{const n=norm(a);if(!(n>1e-12)||!Number.isFinite(n))throw new Error('The path has a singular tangent at this position');return mul(a,1/n);};

function quadrature(speed,a,b,tolerance,leaves=null,budget={left:200000}){
  const value=t=>{if(--budget.left<0)throw new Error('Arc-length integration exceeded its refinement limit');const v=speed(t);if(!Number.isFinite(v))throw new Error('The path derivative is not finite');return v;};
  const simpson=(a,b,fa,fm,fb)=>(b-a)*(fa+4*fm+fb)/6;
  const recurse=(a,b,fa,fm,fb,whole,tol,depth)=>{
    const m=(a+b)/2,fl=value((a+m)/2),fr=value((m+b)/2),left=simpson(a,m,fa,fl,fm),right=simpson(m,b,fm,fr,fb),error=left+right-whole;
    if(Math.abs(error)<=15*tol){const length=left+right+error/15;if(leaves)leaves.push({a,b,length});return length;}
    if(!depth||m===a||m===b)throw new Error('Arc-length integration did not converge');
    return recurse(a,m,fa,fl,fm,left,tol/2,depth-1)+recurse(m,b,fm,fr,fb,right,tol/2,depth-1);
  };
  if(a===b)return 0;
  const fa=value(a),fm=value((a+b)/2),fb=value(b);return recurse(a,b,fa,fm,fb,simpson(a,b,fa,fm,fb),tolerance,22);
}

export function locateAlongPath(path,options={},normal=false){
  const {segments,closed=false}=path;if(!segments?.length)throw new Error('Select a nonempty curve or connected path');
  const leaves=[],budget={left:200000};let length=0;
  segments.forEach((segment,index)=>{
    const speed=t=>norm(segment.derivative(t)),rough=(speed(0)+4*speed(.5)+speed(1))/6,tolerance=Math.max(1e-9,rough*1e-11)/segments.length;
    // Initial subintervals reduce aliasing on high-degree rational pieces.
    for(let i=0;i<16;i++){
      const local=[];quadrature(speed,i/16,(i+1)/16,tolerance/16,local,budget);
      for(const leaf of local){leaves.push({...leaf,index,start:length});length+=leaf.length;}
    }
  });
  if(!(Number.isFinite(length)&&length>1e-9))throw new Error('The selected path has zero length');
  if(path.nativeLength!=null&&Math.abs(length-path.nativeLength)>Math.max(1e-6,length*1e-8))throw new Error('Arc-length integration disagrees with the CAD curve length');
  const tolerance=Math.max(1e-7,length*1e-10),mode=options.positionMode||'fraction';let distance;
  if(mode==='distance'){
    distance=options.distance??0;if(!Number.isFinite(distance)||distance<0||distance>length+tolerance)throw new Error(`Distance must be between 0 and the path length (${length.toFixed(6)} mm)`);distance=Math.min(length,distance);
  }else if(mode==='fraction'){
    const fraction=options.fraction??.5;if(!Number.isFinite(fraction)||fraction<0||fraction>1)throw new Error('Path fraction must be between 0 and 1');distance=length*fraction;
  }else if(mode==='start')distance=0;else if(mode==='end')distance=length;else if(mode==='mid')distance=length/2;else throw new Error('Choose Distance, Fraction, Start, Midpoint or End');
  const target=options.reversePath?length-distance:distance;
  const atDistance=target=>{
    let index=0,t=0;
    if(target>=length){index=segments.length-1;t=1;}
    else if(target>0){
    const leaf=leaves.find(x=>target<=x.start+x.length)||leaves.at(-1);index=leaf.index;
    const desired=target-leaf.start,speed=u=>norm(segments[index].derivative(u));let lo=leaf.a,hi=leaf.b,done=false;
    for(let i=0;i<64;i++){
      t=(lo+hi)/2;const s=quadrature(speed,leaf.a,t,Math.max(1e-11,tolerance/100),null,budget),error=s-desired;
      if(Math.abs(error)<=tolerance/8){done=true;break;}if(error<0)lo=t;else hi=t;
    }
    if(!done)throw new Error('The arc-length location did not converge');
    }
    return {index,t};
  };
  const {index,t}=atDistance(target);
  const p=segments[index].point(t);if(!p.every(Number.isFinite))throw new Error('The path position is not finite');
  let tangent;
  if(normal){
    tangent=unit(segments[index].derivative(t));
    // No arbitrary choice of tangent at a corner, cusp or nonsmooth closed seam.
    const nearStart=norm(sub(p,segments[index].point(0)))<=tolerance,nearEnd=norm(sub(p,segments[index].point(1)))<=tolerance;
    const compare=(a,b)=>{if(dot(unit(a),unit(b))<1-1e-8)throw new Error('The path has no unique tangent at this corner or seam; choose a position away from it');};
    if(nearStart&&(index>0||closed))compare(segments[(index+segments.length-1)%segments.length].derivative(1),segments[index].derivative(0));
    if(nearEnd&&(index<segments.length-1||closed))compare(segments[index].derivative(1),segments[(index+1)%segments.length].derivative(0));
    if(nearStart&&segments[index].endpointDerivative)unit(segments[index].endpointDerivative(0));
    if(nearEnd&&segments[index].endpointDerivative)unit(segments[index].endpointDerivative(1));
    const neighbourhood=[Math.max(0,target-4*tolerance),Math.min(length,target+4*tolerance)].map(atDistance);
    const normals=neighbourhood.map(q=>unit(segments[q.index].derivative(q.t)));
    if(dot(normals[0],normals[1])<1-1e-6)throw new Error('The tangent is singular or changes too sharply within the arc-length precision; choose another position');
    if(options.reversePath)tangent=mul(tangent,-1);
  }
  return {p,tangent,length,distance,fraction:distance/length,tolerance};
}

const bezier=(p,t)=>{let q=p.map(a=>[...a]);while(q.length>1)q=q.slice(1).map((b,i)=>add(mul(q[i],1-t),mul(b,t)));return q[0];};
export function sketchPath(S,sk,c,frame){
  const point=q=>frame.o.map((x,i)=>x+frame.u[i]*q[0]+frame.v[i]*q[1]),vector=q=>frame.u.map((x,i)=>x*q[0]+frame.v[i]*q[1]);
  const read=id=>{const p=S.getPoint(sk,id);if(!p)throw new Error('A path control point is missing');return [p.x,p.y];};
  let segments;
  if(c.type==='line'){const a=read(c.p1),b=read(c.p2),d=sub(b,a);segments=[{point:t=>point(add(a,mul(d,t))),derivative:()=>vector(d)}];}
  else if(c.type==='circle'||c.type==='arc'){
    const center=read(c.c),arc=c.type==='arc'?S.arcAngles(sk,c):{a0:0,span:2*Math.PI,r:c.r};
    if(!(Number.isFinite(arc.r)&&arc.r>0))throw new Error('The path radius must be finite and positive');
    segments=[{point:t=>point(add(center,[arc.r*Math.cos(arc.a0+t*arc.span),arc.r*Math.sin(arc.a0+t*arc.span)])),derivative:t=>vector([-arc.r*arc.span*Math.sin(arc.a0+t*arc.span),arc.r*arc.span*Math.cos(arc.a0+t*arc.span)])}];
  }else if(c.type==='spline'){
    const pieces=c.ctrl?S.bsplineBeziers(c.pts.map(read),c.degree??3,!!c.closed,c.weights):S.splinePieces(sk,c).map(g=>[g.a,g.c1,g.c2,g.b]);
    segments=pieces.map(p=>{
      const d=p.slice(1).map((b,i)=>mul(sub(b,p[i]),p.length-1)),rational=p[0].length===3;
      const at=t=>{const q=bezier(p,t);if(rational){if(!(q[2]>0))throw new Error('The path spline has invalid weights');return [q[0]/q[2],q[1]/q[2]];}return q;};
      return {point:t=>point(at(t)),derivative:t=>{const q=bezier(d,t);if(!rational)return vector(q);const h=bezier(p,t),p2=at(t);return vector([(q[0]-p2[0]*q[2])/h[2],(q[1]-p2[1]*q[2])/h[2]]);}};
    });
  }else throw new Error('Along path supports sketch lines, arcs, circles and splines');
  return {segments,closed:c.type==='circle'||!!c.closed};
}

export function cadPath(R,shape,wire=false){
  const oc=R.getOC(),ad=wire?new oc.BRepAdaptor_CompCurve(shape.wrapped,false):new oc.BRepAdaptor_Curve(shape.wrapped);let bounds;
  const xyz=p=>{try{return [p.X(),p.Y(),p.Z()];}finally{p.delete();}};
  try{
    const count=ad.NbIntervals(oc.GeomAbs_Shape.GeomAbs_C1);bounds=new oc.NCollection_Array1_double(1,count+1);ad.Intervals(bounds,oc.GeomAbs_Shape.GeomAbs_C1);
    const segments=Array.from({length:count},(_,i)=>{
      const a=bounds.Value(i+1),b=bounds.Value(i+2),span=b-a;
      return {point:t=>xyz(ad.Value(a+span*t)),derivative:t=>mul(xyz(ad.DN(a+span*Math.max(1e-12,Math.min(1-1e-12,t)),1)),span),endpointDerivative:t=>mul(xyz(ad.DN(a+span*t,1)),span)};
    });
    return {segments,closed:ad.IsClosed(),nativeLength:R.measureLength(shape),delete:()=>ad.delete()};
  }catch(e){ad.delete();throw e;}finally{bounds?.delete();}
}
