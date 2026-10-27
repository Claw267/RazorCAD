// A bounded scale law for the native auxiliary-spine sweep. Normal-plane
// intersections are evaluated on CAD curves, not their display polylines.
const dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0);
const sub=(a,b)=>a.map((x,i)=>x-b[i]);
const xyz=(p)=>[p.X(),p.Y(),p.Z()];
const length=(p)=>Math.hypot(...p);
export function guideScaleLaw(R,path,guide,initialRadius,tolerance) {
  const oc=R.getOC(),spine=new oc.BRepAdaptor_CompCurve(path.wrapped,false),rail=new oc.BRepAdaptor_CompCurve(guide.wrapped,false);
  const s0=spine.FirstParameter(),ds=spine.LastParameter()-s0,g0=rail.FirstParameter(),dg=rail.LastParameter()-g0;
  const value=(curve,u)=>{const p=curve.Value(u);try{return xyz(p);}finally{p.delete();}};
  const speed=(t)=>{const v=spine.DN(s0+ds*t,1);try{return length(xyz(v))*ds;}finally{v.delete();}};
  let law;
  try {
    const samples=Array.from({length:129},(_,i)=>value(rail,g0+dg*i/128));
    const scales=new Map(),abscissas=new Map();
    const scale=(t)=>{
      if(scales.has(t))return scales.get(t);
      const p=value(spine,s0+ds*t),v=spine.DN(s0+ds*t,1);let n;
      try{const d=xyz(v),l=length(d);if(!(l>0))throw new Error('The sweep path has a singular tangent');n=d.map((x)=>x/l);}finally{v.delete();}
      const distances=samples.map((q)=>dot(sub(q,p),n)),roots=[];
      const add=(q)=>{if(!roots.some((r)=>length(sub(r,q))<1e-6))roots.push(q);};
      for(let i=0;i<128;i++){
        if(Math.abs(distances[i])<1e-9)add(samples[i]);
        if(distances[i]*distances[i+1]<0){
          let lo=i/128,hi=(i+1)/128,left=distances[i],q;
          for(let j=0;j<40;j++){
            const mid=(lo+hi)/2;q=value(rail,g0+dg*mid);const d=dot(sub(q,p),n);
            if(Math.abs(d)<1e-10)break;
            if(left*d>0){lo=mid;left=d;}else hi=mid;
          }
          add(q);
        }
      }
      if(Math.abs(distances[128])<1e-9)add(samples[128]);
      if(roots.length!==1)throw new Error('Section size requires exactly one guide intersection in every path normal plane');
      const radius=length(sub(roots[0],p));
      if(!(radius>tolerance))throw new Error('The sweep guide crosses or approaches the path too closely');
      scales.set(t,radius/initialRadius);return radius/initialRadius;
    };
    // Adaptive Simpson integration supplies the law's arc-length coordinate.
    const integrate=(a,b)=>{
      const fa=speed(a),fb=speed(b),fm=speed((a+b)/2),whole=(b-a)*(fa+4*fm+fb)/6;
      const refine=(a,b,fa,fm,fb,whole,eps,depth)=>{
        const m=(a+b)/2,l=speed((a+m)/2),r=speed((m+b)/2);
        const left=(m-a)*(fa+4*l+fm)/6,right=(b-m)*(fm+4*r+fb)/6,error=left+right-whole;
        if(Math.abs(error)<=15*eps)return left+right+error/15;
        if(!depth)throw new Error('The sweep path arc length could not be resolved');
        return refine(a,m,fa,l,fm,left,eps/2,depth-1)+refine(m,b,fm,r,fb,right,eps/2,depth-1);
      };
      return refine(a,b,fa,fm,fb,whole,1e-8,16);
    };
    const total=integrate(0,1),nativeLength=R.measureLength(path);
    if(!(total>0)||Math.abs(total-nativeLength)>Math.max(1e-6,nativeLength*1e-7))throw new Error('The sweep path has an inconsistent arc length');
    const abscissa=(t)=>{if(!abscissas.has(t))abscissas.set(t,t===0?0:t===1?nativeLength:integrate(0,t)*nativeLength/total);return abscissas.get(t);};
    for(const count of [8,16,32,64,128]){
      law?.delete();law=new oc.Law_Interpol();
      const points=new oc.NCollection_Array1_gp_Pnt2d(1,count+1);
      try{
        for(let i=0;i<=count;i++){const p=new oc.gp_Pnt2d(abscissa(i/count),scale(i/count));try{points.SetValue(i+1,p);}finally{p.delete();}}
        law.Set(points,false);
      }finally{points.delete();}
      let error=0;
      for(let i=0;i<count;i++)for(const offset of [0.19,0.53,0.83]){
        const t=(i+offset)/count,predicted=law.Value(abscissa(t));
        if(!(predicted>0))throw new Error('The sweep scale law collapses the profile');
        error=Math.max(error,Math.abs(predicted-scale(t))*initialRadius);
      }
      if(error<=tolerance*0.1){const result=law;law=null;return result;}
    }
    throw new Error('The guide scale law exceeds 0.0001 mm after bounded refinement');
  }finally{law?.delete();spine.delete();rail.delete();}
}
