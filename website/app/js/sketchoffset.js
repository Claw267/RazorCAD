// Parametric sketch offsets. Lines/arcs stay analytic; spline parallels are
// fitted with cubic pieces and checked against the original curve normals.
import * as S from './sketchmodel.js';
export const TOLERANCE=.001;
export function chainOf(sk,id,selectChain=true){
  const c=S.getCurve(sk,id);if(!c)return null;
  if(!selectChain)return {items:[{c,rev:false}],closed:['circle','ellipse'].includes(c.type)||c.type==='spline'&&!!c.closed};
  return S.chainOf({...sk,curves:sk.curves.filter(q=>!q.ctrlOf||q.id===id)},id);
}
const add=(a,b)=>a.map((v,i)=>v+b[i]),sub=(a,b)=>a.map((v,i)=>v-b[i]),mul=(a,k)=>a.map(v=>v*k),len=a=>Math.hypot(...a),cross=(a,b)=>a[0]*b[1]-a[1]*b[0];
const point=(sk,id)=>{const p=S.getPoint(sk,id);if(!p)throw new Error('An offset source point is missing');return [p.x,p.y];};
function evaluator(sk,{c,rev}){
  let raw,n=1;
  if(c.type==='line'){const a=point(sk,c.p1),b=point(sk,c.p2),v=sub(b,a);raw=t=>({p:add(a,mul(v,t)),v,acc:[0,0]});}
  else if(c.type==='arc'||c.type==='circle'){
    const center=point(sk,c.c),g=c.type==='arc'?S.arcAngles(sk,c):{r:c.r,a0:0,span:2*Math.PI};
    raw=t=>{const a=g.a0+g.span*t,u=[Math.cos(a),Math.sin(a)];return {p:add(center,mul(u,g.r)),v:mul([-u[1],u[0]],g.r*g.span),acc:mul(u,-g.r*g.span*g.span)};};
  }else if(c.type==='spline'){
    const pieces=S.splinePieces(sk,c);n=pieces.length;
    raw=(t,side=1)=>{const x=t*n,i=Math.max(0,Math.min(n-1,side<0&&Math.abs(x-Math.round(x))<1e-9?Math.round(x)-1:Math.floor(x))),u=x-i,g=pieces[i],w=1-u;
      return {p:S.bezierAt(g,u),v:[0,1].map(k=>3*n*(w*w*(g.c1[k]-g.a[k])+2*w*u*(g.c2[k]-g.c1[k])+u*u*(g.b[k]-g.c2[k]))),acc:[0,1].map(k=>6*n*n*(w*(g.c2[k]-2*g.c1[k]+g.a[k])+u*(g.b[k]-2*g.c2[k]+g.c1[k])))};};
  }else throw new Error('Offset supports lines, arcs, circles and splines');
  return {n,at:(t,side=1)=>{const q=raw(rev?1-t:t,rev?-side:side);return {...q,v:rev?mul(q.v,-1):q.v};}};
}
function parallel(ev,t,d,check=true,side=1){
  const q=ev.at(t,side),speed=len(q.v),curvature=cross(q.v,q.acc)/(speed**3||1e-30),factor=1-d*curvature;
  if(check&&(speed<1e-9||factor<=1e-7))throw new Error('The offset collapses at a cusp or tight bend; reduce its distance');
  const normal=[-q.v[1]/(speed||1e-30),q.v[0]/(speed||1e-30)];
  return {p:add(q.p,mul(normal,d)),v:mul(q.v,factor)};
}
function junction(a,b,d,check){
  let u=1,v=0;
  for(let i=0;i<24;i++){
    const p=parallel(a,u,d,false),q=parallel(b,v,d,false),delta=sub(q.p,p.p);
    if(len(delta)<1e-7)return [u,v];
    const den=cross(p.v,q.v);if(Math.abs(den)<1e-12)break;
    const du=cross(delta,q.v)/den,dv=cross(delta,p.v)/den;
    u+=Math.max(-.25,Math.min(.25,du));v+=Math.max(-.25,Math.min(.25,dv));
    if(u<-.5||u>1.5||v<-.5||v>1.5)break;
  }
  if(check)throw new Error('The offset curves cannot be joined without a fold; reduce the distance or select individual segments');
  return [1,0];
}
const cubic=(ev,a,b,d,check)=>{const p=parallel(ev,a,d,check),q=parallel(ev,b,d,check,-1),h=(b-a)/3;return {type:'bezier',a:p.p,c1:add(p.p,mul(p.v,h)),c2:sub(q.p,mul(q.v,h)),b:q.p};};
function fitError(ev,g,a,b,d,check){let error=0;for(let i=1;i<16;i++){const t=i/16;error=Math.max(error,len(sub(S.bezierAt(g,t),parallel(ev,a+(b-a)*t,d,check).p)));}return error;}
export function geometry(sk,chain,d,layout=null,check=true){
  if(!chain?.items?.length||!Number.isFinite(d))throw new Error('Select curves and enter a finite offset distance');
  const evals=chain.items.map(it=>evaluator(sk,it)),ranges=evals.map(()=>[0,1]);
  for(let i=0;i<evals.length-(chain.closed?0:1);i++){
    if(evals.length===1&&chain.items[0].c.type==='circle')break;
    const j=(i+1)%evals.length,[u,v]=junction(evals[i],evals[j],d,check);ranges[i][1]=u;ranges[j][0]=v;
  }
  const pieces=[],intervals=[];
  evals.forEach((ev,i)=>{
    const {c,rev}=chain.items[i],[lo,hi]=ranges[i];if(check&&hi-lo<1e-8)throw new Error('The offset consumes an entire segment; reduce its distance');
    if(c.type==='circle'||c.type==='arc'){
      const center=point(sk,c.c),a=parallel(ev,lo,d,check).p,b=parallel(ev,hi,d,check).p,r=len(sub(a,center));
      if(check&&c.type==='arc'&&(hi-lo)*S.arcAngles(sk,c).span>=2*Math.PI-1e-8)throw new Error('The offset would wrap an arc around itself; reduce its distance');
      pieces.push({type:c.type,c:center,r,a,b,rev,source:i,span:(hi-lo)*(c.type==='circle'?2*Math.PI:S.arcAngles(sk,c).span)});intervals.push(null);
    }else if(c.type==='line'){
      pieces.push({type:'line',a:parallel(ev,lo,d,check).p,b:parallel(ev,hi,d,check).p,source:i});intervals.push(null);
    }else{
      const spans=layout?.[i]||[];
      const fit=(a,b,depth)=>{const t0=lo+(hi-lo)*a,t1=lo+(hi-lo)*b,g=cubic(ev,t0,t1,d,check),error=fitError(ev,g,t0,t1,d,check);
        if(error>TOLERANCE*.5&&depth<10){const m=(a+b)/2;fit(a,m,depth+1);fit(m,b,depth+1);}else{if(check&&error>TOLERANCE)throw new Error('The spline offset exceeds 0.001 mm fitting tolerance');spans.push([a,b]);}};
      if(!layout)for(let j=0;j<ev.n;j++)fit(j/ev.n,(j+1)/ev.n,0);
      for(const [a,b] of spans){const t0=lo+(hi-lo)*a,t1=lo+(hi-lo)*b,g=cubic(ev,t0,t1,d,check);if(check&&fitError(ev,g,t0,t1,d,true)>TOLERANCE)throw new Error('The edited spline needs a finer offset fit; recreate this offset');pieces.push({...g,source:i});}
      intervals.push(spans);
    }
  });
  // Detect sampled folds and crossings, including between nonadjacent pieces.
  if(check){const paths=polylines(pieces),edges=[];paths.forEach((p,pi)=>{for(let j=1;j<p.length;j++)edges.push({a:p[j-1],b:p[j],pi});});
    for(let i=0;i<edges.length;i++)for(let j=i+2;j<edges.length;j++){const a=edges[i],b=edges[j],u=sub(a.b,a.a),v=sub(b.b,b.a),den=cross(u,v);if(Math.abs(den)<1e-12)continue;const q=sub(b.a,a.a),t=cross(q,v)/den,s=cross(q,u)/den;if(t>1e-7&&t<1-1e-7&&s>1e-7&&s<1-1e-7)throw new Error('The offset intersects itself; reduce its distance');}
  }
  return {pieces,layout:intervals};
}
export function polylines(pieces){return pieces.map(g=>{
  if(g.type==='line')return [g.a,g.b];if(g.type==='bezier')return Array.from({length:25},(_,i)=>S.bezierAt(g,i/24));
  const a=Math.atan2(g.a[1]-g.c[1],g.a[0]-g.c[0]),span=g.span*(g.rev?-1:1),n=Math.max(12,Math.ceil(Math.abs(span)*16));return Array.from({length:n+1},(_,i)=>add(g.c,mul([Math.cos(a+span*i/n),Math.sin(a+span*i/n)],g.r)));
});}
export function side(sk,chain,x,y){
  if(chain.items.every(it=>['line','arc','circle'].includes(it.c.type)))return S.chainSide(sk,chain,x,y);
  let best=Infinity,signed=0;
  for(const it of chain.items){const ev=evaluator(sk,it),n=Math.max(64,ev.n*32);for(let j=0;j<n;j++){const a=ev.at(j/n).p,b=ev.at((j+1)/n).p,v=sub(b,a),p=sub([x,y],a),t=Math.max(0,Math.min(1,(p[0]*v[0]+p[1]*v[1])/(len(v)**2||1))),q=sub([x,y],add(a,mul(v,t))),distance=len(q);if(distance<best){best=distance;signed=cross(v,p)/(len(v)||1);}}}
  return signed;
}
export function distances(sk,chain,value,mode='side'){
  if(mode==='both')return [Math.abs(value),-Math.abs(value)];
  if(mode==='side')return [value];
  let interior=1;
  if(chain.closed){const p=chain.items.flatMap(it=>{const ev=evaluator(sk,it);return Array.from({length:32},(_,j)=>ev.at(j/32).p);});let area=0;p.forEach((a,i)=>{area+=cross(a,p[(i+1)%p.length]);});interior=area<0?-1:1;}
  return [Math.abs(value)*interior*(mode==='outside'?-1:1)];
}
export function targets(sk,k,value,check=true){
  const chain={closed:k.closed,items:k.chain.map(it=>{const c=S.getCurve(sk,it.id);if(!c)throw new Error('An offset source curve is missing');return {c,rev:it.rev};})};
  const g=geometry(sk,chain,k.sign*value,k.layout,check),points={},radii={};
  for(const b of k.bindings){const item=g.pieces[b.item];if(!item)throw new Error('The source offset topology changed; recreate the offset');if(b.radius)radii[b.radius]=item.r;else points[b.id]=item[b.part];}
  return {points,radii};
}
export function dimensionPair(sk,k,value){const it=k.chain[0],c=S.getCurve(sk,it.id),ev=evaluator(sk,{c,rev:it.rev});return [ev.at(.5).p,parallel(ev,.5,k.sign*value,false).p];}
export function build(sk,chain,values,{construction=!!chain.items[0].c.construction,value=null}={}){
  const plans=values.map(d=>geometry(sk,chain,d)),created=[],groups=[];
  const dim=S.addRel(sk,'dim',[],{kind:'offset',value:value??Math.abs(values[0])});
  plans.forEach((plan,sideIndex)=>{
    const bindings=[],outputs=[],newPoint=(p,item,part)=>{const id=S.addPoint(sk,...p);created.push(id);bindings.push({id,item,part});return id;};
    let start=null,previous=null;
    plan.pieces.forEach((g,i)=>{
      let id;
      if(g.type==='circle'){const c=newPoint(g.c,i,'c');id=S.addCircle(sk,c,g.r,construction);bindings.push({radius:id,item:i});}
      else{
        const a=previous||newPoint(g.a,i,'a');if(!start)start=a;
        const b=chain.closed&&i===plan.pieces.length-1?start:newPoint(g.b,i,'b');previous=b;
        if(g.type==='line')id=S.addLine(sk,a,b,construction);
        else if(g.type==='arc'){const center=newPoint(g.c,i,'c');id=S.addArc(sk,center,g.rev?b:a,g.rev?a:b,construction);}
        else{const h1=newPoint(g.c1,i,'c1'),h2=newPoint(g.c2,i,'c2');id=S.addCtrlSpline(sk,[a,h1,h2,b],3,construction);}
      }
      outputs.push(id);created.push(id);
    });
    const k=S.addRel(sk,'offsetGeometry',[...chain.items.map(it=>it.c.id),...outputs],{chain:chain.items.map(it=>({id:it.c.id,rev:!!it.rev})),closed:chain.closed,bindings,layout:plan.layout,dim:dim.id,sign:Math.sign(values[sideIndex]),v:Math.abs(values[sideIndex])});groups.push(k);
    if(!sideIndex){dim.refs=[chain.items[0].c.id,outputs[0]];dim.offsetGroup=k.id;}
  });
  return {dim,created,groups};
}
