// Stable, profile-keyed loft correspondence. Cyclic shifts preserve boundary
// order; arbitrary vertex permutations would cross the section topology.
import * as S from './sketchmodel.js';
import * as LR from './loftrefs.js';
const sub=(a,b)=>a.map((x,i)=>x-b[i]),add=(a,b)=>a.map((x,i)=>x+b[i]),mul=(a,k)=>a.map(x=>x*k),length=a=>Math.hypot(...a),dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0),cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
export const connectionFor=(feature,ref)=>Object.hasOwn(feature.loftCorrespondence||{},LR.refKey(ref))?feature.loftCorrespondence[LR.refKey(ref)]:null;
export const hasManualConnections=feature=>feature.correspondenceMode==='manual'||feature.correspondenceMode!=='auto'&&(feature.profiles||[]).some(ref=>{const c=connectionFor(feature,ref);return !!(c&&(c.point||c.circle||c.reverse));});

export function profileConnectionOptions(sk,ref){
  const resolved=typeof ref==='string'?{sketch:sk}:LR.resolveContour(sk,ref),subset=resolved.sketch;
  const regions=resolved.region?[resolved.region]:S.profileRegions(subset,true),chains=S.curveChains(subset);
  const closed=!!resolved.region||chains.length===1&&chains[0].closed;
  const segs=closed&&regions.length===1?regions[0].outer.segs:chains.length===1?S.chainSegs(subset,chains[0]):[];
  if(!segs.length)throw new Error('Select one profile contour before editing its correspondence');
  const circle=segs.length===1&&segs[0].type==='circle'?subset.curves.find(c=>c.id===segs[0].sourceCurve)||subset.curves.find(c=>{const p=c.type==='circle'&&S.getPoint(sk,c.c);return p&&Math.hypot(p.x-segs[0].c[0],p.y-segs[0].c[1])<1e-6&&Math.abs(c.r-segs[0].r)<1e-6;}):null;
  const ends=segs.length===1&&circle?[]:closed?segs.flatMap(g=>[g.a,g.b]).filter(Boolean):[segs[0].a,segs.at(-1).b];
  const points=[{id:'O',x:0,y:0},...sk.points].filter(p=>ends.some(q=>Math.hypot(p.x-q[0],p.y-q[1])<1e-6));
  return {closed,circle:circle?{curve:circle.id,c:S.getPoint(sk,circle.c),r:segs[0].r}:null,points:[...new Map(points.map(p=>[p.id,p])).values()]};
}

export function connectionAnchor(sk,ref,frame,control,evaluate=Number){
  if(!control)return null;
  const options=profileConnectionOptions(sk,ref);
  if(control.point){
    const p=options.points.find(p=>p.id===control.point);if(!p)throw new Error(`${sk.name}: the connector point is missing or is no longer on this profile boundary; reselect it`);
    return S.fromFrame2D(frame,p.x,p.y);
  }
  if(control.circle){
    if(options.circle?.curve!==control.circle)throw new Error(`${sk.name}: the circular connector source changed; reselect it`);
    const angle=evaluate(control.angle??0)*Math.PI/180;if(!Number.isFinite(angle))throw new Error('The connector seam angle must be finite');
    return S.fromFrame2D(frame,options.circle.c.x+options.circle.r*Math.cos(angle),options.circle.c.y+options.circle.r*Math.sin(angle));
  }
  return null;
}

export const reverseSection=s=>({...s,segs:s.segs.slice().reverse().map(g=>({...g,a:g.b,b:g.a,...(g.type==='bezier'?{c1:g.c2,c2:g.c1}:{}),...(g.type==='pts'?{pts:g.pts.slice().reverse(),L:g.L.map(x=>g.L.at(-1)-x).reverse()}: {})}))});

export function applySectionConnections(matched,original,controls,expandCircles=false){
  if(controls.some(c=>!!c?.reverse!==!!controls[0]?.reverse))throw new Error('Invalid loft correspondence: closed profiles must share the same traversal direction; reverse all profiles together or change their start points');
  const allCircles=matched.every(s=>s.circle);
  if(allCircles&&(expandCircles||controls.some(c=>c?.anchor||c?.reverse))){
    const reference=matched[0].circle;
    matched=matched.map(s=>{
      const {c,r}=s.circle,n=dot(s.circle.n,reference.n)<0?mul(s.circle.n,-1):s.circle.n,projected=sub(reference.u,mul(n,dot(reference.u,n))),u=length(projected)>1e-9?mul(projected,1/length(projected)):s.circle.u,v=cross(n,u),at=t=>add(c,add(mul(u,r*Math.cos(t)),mul(v,r*Math.sin(t))));
      return {segs:Array.from({length:4},(_,i)=>({type:'arc',a:at(i*Math.PI/2),m:at((i+.5)*Math.PI/2),b:at((i+1)*Math.PI/2)}))};
    });
  }
  return matched.map((section,i)=>{
    const control=controls[i];if(!control||!control.anchor&&!control.reverse)return section;
    if(section.circle)throw new Error('The circular connector could not be expanded into matching sections');
    let s=section;
    if(control.anchor){
      if(original[i].circle){
        const {c,n}=original[i].circle,a=sub(s.segs[0].a,c),b=sub(control.anchor,c),angle=Math.atan2(dot(cross(a,b),n),dot(a,b));
        const rotate=p=>{const q=sub(p,c);return add(c,add(add(mul(q,Math.cos(angle)),mul(cross(n,q),Math.sin(angle))),mul(n,dot(n,q)*(1-Math.cos(angle)))));};
        s={segs:s.segs.map(g=>({...g,a:rotate(g.a),b:rotate(g.b),...(g.m?{m:rotate(g.m)}:{})}))};
      }else{
        const start=s.segs.findIndex(g=>length(sub(g.a,control.anchor))<=1e-5);
        if(start<0)throw new Error('The connector must attach to an existing profile vertex; split the curve at the desired location first');
        s={segs:[...s.segs.slice(start),...s.segs.slice(0,start)]};
      }
    }
    return control.reverse?reverseSection(s):s;
  });
}
