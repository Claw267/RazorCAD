// Analytic reference geometry constraints. No tessellation or iterative fitting:
// solve affine equations, then intersect the direction subspace with the unit sphere.
const EPS=1e-8, dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0), sub=(a,b)=>a.map((x,i)=>x-b[i]), add=(a,b)=>a.map((x,i)=>x+b[i]), mul=(a,t)=>a.map(x=>x*t), norm=a=>Math.hypot(...a);
const unit=a=>{const l=norm(a);if(!(l>EPS)||!Number.isFinite(l))throw new Error('A reference direction is invalid or has zero length');return mul(a,1/l);};
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const row=(a,b=0)=>({a,b});
const datumGeometry=(type,g)=>type==='plane'&&g.kind==='line'&&['circle','arc'].includes(g.curve?.type)?{kind:'plane',n:g.d,p:g.curve.c,fromCurve:true}:g;

function affine(rows,n){
  if(rows.some(r=>![...r.a,r.b].every(Number.isFinite)))throw new Error('Reference coordinates, distances and angles must be finite');
  const a=rows.map(({a,b})=>{const scale=norm(a);if(scale<EPS){if(Math.abs(b)>EPS)throw new Error('The reference relations conflict');return [...a,b];}return [...a.map(x=>x/scale),b/scale];}),pivots=[];
  let r=0;
  for(let c=0;c<n&&r<a.length;c++){
    let p=r;for(let i=r+1;i<a.length;i++)if(Math.abs(a[i][c])>Math.abs(a[p][c]))p=i;
    if(Math.abs(a[p][c])<EPS)continue;
    [a[r],a[p]]=[a[p],a[r]];const v=a[r][c];a[r]=a[r].map(x=>x/v);
    for(let i=0;i<a.length;i++)if(i!==r){const v=a[i][c];a[i]=a[i].map((x,j)=>x-v*a[r][j]);}
    pivots.push(c);r++;
  }
  for(const x of a)if(norm(x.slice(0,n))<EPS&&Math.abs(x[n])>EPS)throw new Error('The reference relations conflict');
  const origin=Array(n).fill(0);pivots.forEach((c,i)=>origin[c]=a[i][n]);
  const basis=[];for(let c=0;c<n;c++)if(!pivots.includes(c)){const v=Array(n).fill(0);v[c]=1;pivots.forEach((p,i)=>v[p]=-a[i][c]);basis.push(v);}
  return {origin,basis};
}

function directions(rows,n=3){
  const s=affine(rows,n),basis=[];let extra=0;
  for(let v of s.basis){for(const q of basis)v=sub(v,mul(q,dot(v.slice(0,3),q.slice(0,3))));const l=norm(v.slice(0,3));if(l<EPS){extra++;continue;}basis.push(mul(v,1/l));}
  let origin=s.origin;for(const q of basis)origin=sub(origin,mul(q,dot(origin.slice(0,3),q.slice(0,3))));
  const radius2=1-dot(origin.slice(0,3),origin.slice(0,3));
  if(radius2 < -EPS || !basis.length&&Math.abs(radius2)>EPS)throw new Error('The requested reference angles or directions are incompatible');
  if(!basis.length||radius2<EPS)return {values:[origin],dof:extra};
  const v=mul(basis[0],Math.sqrt(Math.max(0,radius2)));
  return {values:[add(origin,v),sub(origin,v)],dof:extra+Math.max(0,basis.length-1)};
}

export function referenceRelations(type,g){
  if(g.kind==='path')return type==='axis'?[]:['alongPath'];
  const path=g.curve&&type!=='axis'?['alongPath']:[];
  g=datumGeometry(type,g);
  if(type==='plane')return g.kind==='point'?['coincident']:g.kind==='plane'?[...path,'coincident','offset','parallel','perpendicular','angle',...(path.length?[]:['midplane'])]:g.kind==='cylinder'?['tangent']:[...path,'coincident','parallel','perpendicular','normal','angle'];
  if(type==='axis')return g.kind==='point'?['coincident']:g.kind==='plane'?['coincident','parallel','perpendicular']:g.kind==='cylinder'?['centerline']:['coincident','parallel','perpendicular'];
  return g.kind==='point'?['coincident']:g.kind==='plane'?['coincident','offset']:g.kind==='cylinder'?[]:[...path,'coincident',...(g.curve?['start','end','midpoint',...(g.curve.type!=='line'?['center']:[]),...(!['circle','arc'].includes(g.curve.type)?['distance']:[])]:[])];
}

export const RELATION_LABELS={alongPath:'Along path (arc length)',coincident:'Coincident / through',offset:'Offset',parallel:'Parallel',perpendicular:'Perpendicular',normal:'Normal at position',angle:'At angle',midplane:'Midplane / bisector',tangent:'Tangent',centerline:'Centre axis',start:'Start point',end:'End point',midpoint:'Midpoint',center:'Arc / circle centre',distance:'Distance from start'};

export function defaultReferenceRelations(type,geo,options={}){
  geo=geo.map(g=>datumGeometry(type,g));
  const count=k=>geo.filter(g=>g.kind===k).length;
  if(type==='plane')return geo.map(g=>g.kind==='path'?'alongPath':g.kind==='point'?'coincident':g.kind==='cylinder'?'tangent':g.kind==='plane'?(g.fromCurve?'coincident':count('cylinder')?'parallel':count('plane')===2?'midplane':count('line')?'angle':count('point')?'parallel':'offset'):(count('plane')?'coincident':count('point')?(options.through?'coincident':'perpendicular'):geo.length===1?'normal':'coincident'));
  if(type==='axis')return geo.map(g=>g.kind==='cylinder'?'centerline':g.kind==='plane'&&count('point')?'perpendicular':'coincident');
  return geo.map(g=>g.kind==='path'?'alongPath':g.kind==='line'&&g.curve&&geo.length===1?'midpoint':'coincident');
}

function located(g,r,options){
  const method=r.relation,curve=g.curve;
  if(method==='center'){if(!curve?.c)throw new Error('Centre requires a circular edge or sketch arc');return curve.c;}
  if(method==='distance'){
    if(curve?.type!=='line')throw new Error('Distance from start currently requires a straight edge or sketch line');
    const distance=r.distance??options.along??0,length=norm(sub(g.end,g.start));
    if(!Number.isFinite(distance)||distance<0||distance>length+EPS)throw new Error('Distance must be within the selected segment');
    return add(g.start,mul(unit(sub(g.end,g.start)),distance));
  }
  if(method==='start')return curve?.start||g.start;if(method==='end')return curve?.end||g.end;
  if(method==='midpoint')return curve?.mid||g.mid;
  throw new Error('Select a point location on the curve');
}

export function solveReferenceDatum(type,geo,refs,options={}){
  try{
    geo=geo.map(g=>datumGeometry(type,g));
    if(geo.length!==refs.length||geo.length>3)throw new Error('Use at most three reference slots');
    for(const g of geo)if(g.kind==='line')unit(g.d);
    const defaults=defaultReferenceRelations(type,geo,options),rs=refs.map((r,i)=>({...r,relation:r.relation||defaults[i]}));
    for(let i=0;i<geo.length;i++)if(!referenceRelations(type,geo[i]).includes(rs[i].relation))throw new Error(`Reference ${i+1}: the selected relation is incompatible with this geometry`);
    const rows=[];let fixedDirection;
    const fixed=(a,v)=>{
      if(type!=='point'){a=unit(a);if(fixedDirection&&norm(cross(a,fixedDirection))<EPS&&dot(a,fixedDirection)<0)a=mul(a,-1);fixedDirection ||= a;}
      a.forEach((x,i)=>rows.push(row(Array.from({length:type==='plane'?4:3},(_,j)=>j===i?1:0),x*v)));return a;
    };
    const special=type==='plane'&&(rs.some(r=>['midplane','tangent'].includes(r.relation)));
    let values,dof;
    if(special){
      if(rs.every(r=>r.relation==='midplane')&&geo.length===2&&geo.every(g=>g.kind==='plane')){
        const [a,b]=geo,c=dot(a.n,b.n);
        if(Math.abs(c)>1-EPS){const n=a.n;values=[[...n,(dot(n,a.p)+dot(n,b.p))/2]];}
        else{const sign=c>0?-1:1;values=[sign,-sign].map(s=>{const n=unit(add(a.n,mul(b.n,s)));return [...n,(dot(a.n,a.p)+s*dot(b.n,b.p))/norm(add(a.n,mul(b.n,s)))];});}
      }else{
        const ci=geo.findIndex(g=>g.kind==='cylinder'),c=geo[ci],other=geo.filter((_,i)=>i!==ci),pr=rs.filter((_,i)=>i!==ci);
        if(!c||rs[ci].relation!=='tangent'||other.length>1||other.some((g,i)=>g.kind!=='plane'||pr[i].relation!=='parallel'))throw new Error('Tangent needs a cylinder alone or one parallel plane; midplane needs two plane references');
        if(!(Number.isFinite(c.r)&&c.r>0))throw new Error('The cylinder radius must be finite and positive');
        let rad;if(other.length){rad=other[0].n;if(Math.abs(dot(rad,c.d))>EPS)throw new Error('No plane tangent to this cylinder is parallel to the selected plane');}
        else{const base=Math.abs(c.d[0])<.9?[1,0,0]:[0,1,0],u=unit(sub(base,mul(c.d,dot(base,c.d)))),v=cross(c.d,u),angle=(options.around||0)*Math.PI/180;rad=add(mul(u,Math.cos(angle)),mul(v,Math.sin(angle)));}
        values=[1,-1].map(s=>{const n=mul(rad,s),p=add(c.o,mul(n,c.r));return [...n,dot(n,p)];});
      }
      dof=0;
    }else if(type==='plane'){
      geo.forEach((g,i)=>{
        const r=rs[i],relation=r.relation;
        if(g.kind==='path'){const n=fixed(g.sample.tangent,1);rows.push(row([0,0,0,1],dot(n,g.sample.p)));return;}
        if(g.kind==='point'){rows.push(row([...g.p,-1]));return;}
        const d=g.kind==='plane'?g.n:g.d;
        if(relation==='coincident'||relation==='offset'){
          if(g.kind==='plane'){const n=fixed(d,1);rows.push(row([0,0,0,1],dot(n,g.p)+(relation==='offset'?(r.offset??options.offset??0)*dot(n,d)*(options.flip?-1:1):0)));}
          else{rows.push(row([...g.mid,-1]));rows.push(row([...d,0]));}
        }else if(relation==='parallel'||relation==='perpendicular'){
          if((g.kind==='plane')===(relation==='parallel'))fixed(d,1);else rows.push(row([...d,0]));
        }else if(relation==='normal'){
          fixed(d,1);const pos=options.position==='start'?g.start:options.position==='end'?g.end:options.position==='distance'?located(g,{relation:'distance',distance:options.along},options):g.mid;rows.push(row([0,0,0,1],dot(d,pos)));
        }else if(relation==='angle'){
          const angle=(r.angle??options.angle??90)*(options.flipAngle?-1:1)*Math.PI/180;
          rows.push(row([...d,0],g.kind==='plane'?Math.cos(angle):Math.sin(angle)));
        }
      });
      ({values,dof}=directions(rows,4));
      // Opposite normals of one geometric plane are an orientation choice, not two positions.
      if(values.length===2&&norm(add(values[0],values[1]))<EPS)values=values.slice(0,1);
    }else if(type==='point'){
      geo.forEach((g,i)=>{
        const r=rs[i];
        if(g.kind==='path')fixed(g.sample.p,1);
        else if(g.kind==='point')fixed(g.p,1);
        else if(g.kind==='plane')rows.push(row(g.n,dot(g.n,g.p)+(r.relation==='offset'?(r.offset??0):0)));
        else if(r.relation!=='coincident')fixed(located(g,r,options),1);
        else{
          if(g.curve&&g.curve.type!=='line')throw new Error('Point intersections currently require straight lines or planes');
          const d=unit(g.d);for(let j=0;j<3;j++){const a=d.map((x,k)=>(k===j?1:0)-d[j]*x);rows.push(row(a,dot(a,g.mid)));}
        }
      });
      const solved=affine(rows,3);values=[solved.origin];dof=solved.basis.length;
    }else if(type==='axis'){
      const pts=geo.filter(g=>g.kind==='point'),posRows=[];
      if(pts.length>1){const d=unit(sub(pts[1].p,pts[0].p));fixed(d,1);}
      geo.forEach((g,i)=>{
        const r=rs[i],relation=r.relation;
        if(g.kind==='point')return;
        const d=g.kind==='plane'?g.n:g.d;
        if(g.kind==='cylinder'||g.kind==='line'&&relation!=='perpendicular'||g.kind==='plane'&&relation==='perpendicular'){
          if(g.kind==='line'&&relation==='coincident'||g.kind==='cylinder'){
            const origin=g.kind==='cylinder'?g.o:g.mid;for(let j=0;j<3;j++){const a=d.map((x,k)=>(k===j?1:0)-d[j]*x);posRows.push(row(a,dot(a,origin)));}
          }
          fixed(d,1);
        }else rows.push(row(d));
        if(g.kind==='plane'&&relation==='coincident')posRows.push(row(g.n,dot(g.n,g.p)));
      });
      const positionSpace=affine(posRows,3),direction=directions(rows);if(direction.dof)return {status:'under',dof:direction.dof+Math.max(0,positionSpace.basis.length-1-(pts.length?2:0)),message:'Add references to fix the axis direction and position'};
      const d=unit(direction.values[0]);posRows.push(row(d));
      for(const p of pts)for(let j=0;j<3;j++){const a=d.map((x,k)=>(k===j?1:0)-d[j]*x);posRows.push(row(a,dot(a,p.p)));}
      const pos=affine(posRows,3);dof=pos.basis.length;values=[{o:pos.origin,d}];
    }else throw new Error('Unknown reference datum type');
    if(dof)return {status:'under',dof,message:`Add references: ${dof} degree${dof===1?'':'s'} of freedom remain`};
    const requested=options.solution??(options.bisector||options.flip&&special?1:0),index=Math.max(0,Math.min(values.length-1,requested));
    const value=values[index],numbers=type==='axis'?[...value.o,...value.d]:value;if(!numbers.every(Number.isFinite))throw new Error('The reference definition has no finite solution');
    return {status:'defined',dof:0,alternatives:values.length,value:type==='plane'?{n:value.slice(0,3),h:value[3]}:value};
  }catch(e){return {status:'conflict',message:e.message};}
}
