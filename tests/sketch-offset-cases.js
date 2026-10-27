import * as S from '/js/sketchmodel.js';
import * as O from '/js/sketchoffset.js';
import * as V from '/js/solver.js';
const near=(a,b)=>Math.abs(a-b)<2e-6;
function fixSource(sk){for(const p of sk.points)S.addRel(sk,'fix',[p.id],{x:p.x,y:p.y});for(const c of sk.curves)if(c.type==='circle')S.addRel(sk,'dim',[c.id],{kind:'radius',value:c.r});}
function verify(sk,group,dimension){const expected=O.targets(sk,group,+dimension.value);for(const [id,q] of Object.entries(expected.points)){const p=S.getPoint(sk,id);if(!near(p.x,q[0])||!near(p.y,q[1]))throw new Error('Offset lost a parametric point');}for(const [id,r] of Object.entries(expected.radii))if(!near(S.getCurve(sk,id).r,r))throw new Error('Offset lost radius');}
export function run(){const results=[];
  for(const type of ['line','arc','circle','fit','ctrl','rational','mixed','closedSpline','closedMixed']){
    const sk=S.newSketchData();let source;
    if(type==='circle')source=S.addCircle(sk,S.addPoint(sk,0,0),10);
    else if(type==='arc')source=S.addArc(sk,S.addPoint(sk,0,0),S.addPoint(sk,10,0),S.addPoint(sk,0,10));
    else if(type==='line')source=S.addLine(sk,S.addPoint(sk,0,0),S.addPoint(sk,30,0));
    else if(type==='closedSpline')source=S.addCtrlSpline(sk,[[0,0],[30,0],[30,30],[0,30]].map(p=>S.addPoint(sk,...p)),3,false,true);
    else if(type==='closedMixed'){const p=[[0,0],[40,0],[40,30],[0,30]].map(q=>S.addPoint(sk,...q));source=S.addLine(sk,p[0],p[1]);S.addLine(sk,p[1],p[2]);S.addCtrlSpline(sk,[p[2],S.addPoint(sk,30,35),S.addPoint(sk,10,35),p[3]]);S.addLine(sk,p[3],p[0]);}
    else if(type==='rational')source=S.addCtrlSpline(sk,[[10,0],[10,10],[0,10]].map(p=>S.addPoint(sk,...p)),2,false,false,[1,Math.SQRT1_2,1]);
    else{const points=[[0,0],[10,0],[20,8],[30,12]].map(p=>S.addPoint(sk,...p));source=type==='fit'?S.addFitSpline(sk,points):S.addCtrlSpline(sk,points);if(type==='mixed')S.addLine(sk,S.addPoint(sk,-20,0),points[0]);}
    const chain=S.chainOf(sk,source);fixSource(sk);
    try{const built=O.build(sk,chain,[1,-1]);let solved=V.solveSketch(sk,Number);if(!solved.ok||solved.bad.length)throw new Error(JSON.stringify(solved));built.groups.forEach(g=>verify(sk,g,built.dim));
      built.dim.value=2;solved=V.solveSketch(sk,Number);if(!solved.ok||solved.bad.length)throw new Error('Distance edit failed: '+JSON.stringify(solved));built.groups.forEach(g=>verify(sk,g,built.dim));
      const saved=JSON.parse(JSON.stringify(sk));if(!V.solveSketch(saved,Number).ok)throw new Error('Reopen failed');
      S.deleteItems(saved,[built.groups[0].id]);if(!saved.constraints.some(k=>k.id===built.dim.id&&k.offsetGroup===built.groups[1].id)||!V.solveSketch(saved,Number).ok)throw new Error('Deleting one side lost the other side dimension');
      S.deleteItems(saved,[built.groups[1].id]);if(saved.constraints.some(k=>k.id===built.dim.id))throw new Error('Unlinked geometry retained an orphan offset dimension');
      if(type==='rational'){for(const group of built.groups){const geometry=O.targets(sk,group,2);for(const b of group.bindings.filter(b=>b.part==='a'||b.part==='b')){const p=geometry.points[b.id];if(Math.abs(Math.hypot(...p)-(group.sign>0?8:12))>.002)throw new Error('Rational circle offset drift');}}}
      for(const fixed of sk.constraints.filter(k=>k.type==='fix')){fixed.x+=7;fixed.y-=3;}
      solved=V.solveSketch(sk,Number);if(!solved.ok)throw new Error('Source edit failed');built.groups.forEach(g=>verify(sk,g,built.dim));
      if(type==='ctrl'){const changed=sk.constraints.find(k=>k.type==='fix'&&k.refs[0]===S.getCurve(sk,source).pts[1]);changed.y+=.2;solved=V.solveSketch(sk,Number);if(!solved.ok)throw new Error('Control point edit failed');built.groups.forEach(g=>verify(sk,g,built.dim));}
      S.deleteItems(sk,[built.dim.id]);if(!V.solveSketch(sk,Number).ok)throw new Error('Deleting the driving dimension lost its last distance');built.groups.forEach(g=>verify(sk,g,built.dim));
      results.push({type,ok:true,curves:built.created.length});
    }catch(e){results.push({type,ok:false,error:e.message});}
  }
  for(const reverse of [false,true]){
    const sk=S.newSketchData(),p=[[0,0],[40,0],[40,30],[0,30]].map(q=>S.addPoint(sk,...q));p.forEach((id,i)=>S.addLine(sk,id,p[(i+1)%4]));let chain=S.chainOf(sk,sk.curves[0].id);if(reverse)chain={closed:true,items:chain.items.slice().reverse().map(it=>({...it,rev:!it.rev}))};
    const inside=O.geometry(sk,chain,O.distances(sk,chain,2,'inside')[0]),outside=O.geometry(sk,chain,O.distances(sk,chain,2,'outside')[0]);
    const bounds=g=>{const x=g.pieces.flatMap(p=>[p.a[0],p.b[0]]);return [Math.min(...x),Math.max(...x)];};results.push({type:'closed directions '+reverse,ok:near(bounds(inside)[0],2)&&near(bounds(inside)[1],38)&&near(bounds(outside)[0],-2)&&near(bounds(outside)[1],42)});
  }
  const invalid=S.newSketchData(),id=S.addCircle(invalid,S.addPoint(invalid,0,0),2);let rejected=false;try{O.geometry(invalid,S.chainOf(invalid,id),3);}catch{rejected=true;}results.push({type:'collapse rejected',ok:rejected});
  return {ok:results.every(r=>r.ok),results};
}
