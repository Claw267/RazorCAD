import * as S from '/js/sketchmodel.js';
import * as M from '/js/model.js';
import {locateAlongPath,sketchPath} from '/js/pathlocation.js';
import {KernelClient} from '/js/kernelclient.js';
const frame={o:[0,0,0],u:[1,0,0],v:[0,1,0],n:[0,0,1]},close=(a,b,tol=2e-7)=>Math.hypot(...a.map((x,i)=>x-b[i]))<tol;

export function fixture(shape='arc',type='plane',options={}){
  const doc=M.newDoc(),sk=M.createFeature(doc,'sketch',{plane:{ref:'front'},visible:false});let curve;
  if(shape==='arc')curve=S.addArc(sk,'O',S.addPoint(sk,10,0),S.addPoint(sk,0,10));
  else if(shape==='circle')curve=S.addCircle(sk,'O',10);
  else if(shape==='line')curve=S.addLine(sk,S.addPoint(sk,0,0),S.addPoint(sk,10,0));
  else if(shape==='rational')curve=S.addCtrlSpline(sk,[[10,0],[10,10],[0,10]].map(q=>S.addPoint(sk,...q)),2,false,false,[1,Math.SQRT1_2,1]);
  else if(shape==='quintic')curve=S.addCtrlSpline(sk,[[0,0],[.1,0],[.2,0],[1,0],[4,0],[10,0]].map(q=>S.addPoint(sk,...q)),5);
  else if(shape==='cusp')curve=S.addCtrlSpline(sk,[[1,0],[-1,0],[1,0]].map(q=>S.addPoint(sk,...q)),2);
  else if(shape==='fit')curve=S.addFitSpline(sk,[[0,0],[3,8],[11,9],[15,0]].map(q=>S.addPoint(sk,...q)));
  else if(shape==='quadratic')curve=S.addCtrlSpline(sk,[[0,0],[0,2],[2,2]].map(q=>S.addPoint(sk,...q)),2);
  else throw new Error('Unknown fixture');
  doc.features.push(sk);const ref={kind:'sketch',sketch:sk.id,curve,relation:'alongPath',...options};
  const feature=M.createFeature(doc,type,{referenceDefinition:true,refs:[ref],...(type==='point'?{pointType:'references'}:{})});doc.features.push(feature);
  return {doc,sk,curve,ref,feature};
}

export function runMath(){
  const cases=[
    {name:'arc distance uses radians',distance:10*Math.PI/6,positionMode:'distance',p:[5*Math.sqrt(3),5,0],n:[-.5,Math.sqrt(3)/2,0]},
    {name:'arc midpoint',p:[Math.sqrt(50),Math.sqrt(50),0],n:[-Math.SQRT1_2,Math.SQRT1_2,0]},
    {name:'reverse arc',fraction:1/3,reversePath:true,p:[5,5*Math.sqrt(3),0],n:[Math.sqrt(3)/2,-.5,0]},
    {name:'circle end is seam',shape:'circle',positionMode:'end',p:[10,0,0],n:[0,1,0]},
    {name:'line reverse distance',shape:'line',positionMode:'distance',distance:3,reversePath:true,p:[7,0,0],n:[-1,0,0]},
    {name:'line end',shape:'line',positionMode:'end',p:[10,0,0],n:[1,0,0]},
    {name:'rational circle preserves weights',shape:'rational',positionMode:'distance',distance:10*Math.PI/6,p:[5*Math.sqrt(3),5,0],n:[-.5,Math.sqrt(3)/2,0]},
    {name:'nonuniform quintic uses length not parameter',shape:'quintic',fraction:.371,p:[3.71,0,0],n:[1,0,0]},
    {name:'quadratic length analytic',shape:'quadratic',p:[.5,1.5,0],n:[Math.SQRT1_2,Math.SQRT1_2,0],length:2+Math.sqrt(2)*Math.asinh(1)},
    {name:'outside arc rejected',positionMode:'distance',distance:16,reject:true},
    {name:'negative distance rejected',positionMode:'distance',distance:-1,reject:true},
    {name:'fraction outside range rejected',fraction:1.01,reject:true},
    {name:'inactive distance ignored',positionMode:'start',distance:Infinity,p:[10,0,0],n:[0,1,0]},
    {name:'cusp point remains valid',shape:'cusp',normal:false,p:[0,0,0]},
    {name:'cusp plane rejected',shape:'cusp',reject:true},
  ];
  const results=cases.map(c=>{const d=fixture(c.shape||'arc'),path=sketchPath(S,d.sk,S.getCurve(d.sk,d.curve),frame);try{const sample=locateAlongPath(path,c,c.normal!==false);return {name:c.name,ok:!c.reject&&close(sample.p,c.p)&&(!c.n||close(sample.tangent,c.n))&&(!c.length||Math.abs(sample.length-c.length)<1e-7),sample};}catch(e){return {name:c.name,ok:!!c.reject,error:e.message};}});
  const segments=[{point:t=>[10*t,0,0],derivative:()=>[10,0,0]},{point:t=>[10,10*t,0],derivative:()=>[0,10,0]}];
  for(const normal of [false,true])try{const sample=locateAlongPath({segments},{positionMode:'distance',distance:10},normal);results.push({name:'corner '+(normal?'plane':'point'),ok:!normal&&close(sample.p,[10,0,0])});}catch(e){results.push({name:'corner '+(normal?'plane':'point'),ok:normal,error:e.message});}
  return {ok:results.every(r=>r.ok),results};
}

export async function run({threads=1}={}){
  const math=runMath();if(!math.ok)return {ok:false,math};
  const kernel=new KernelClient({threads}),results=[];
  const cases=[
    {name:'plane at arc distance',options:{positionMode:'distance',distance:'10*pi/6'},p:[5*Math.sqrt(3),5,0],n:[-.5,Math.sqrt(3)/2,0]},
    {name:'point at arc distance',type:'point',options:{positionMode:'distance',distance:'10*pi/6'},p:[5*Math.sqrt(3),5,0]},
    {name:'reversed plane normal',options:{fraction:1/3,reversePath:true},p:[5,5*Math.sqrt(3),0],n:[Math.sqrt(3)/2,-.5,0]},
    {name:'rational sketch plane',shape:'rational',options:{positionMode:'distance',distance:'10*pi/6'},p:[5*Math.sqrt(3),5,0],n:[-.5,Math.sqrt(3)/2,0]},
    {name:'rational sketch point',shape:'rational',type:'point',options:{positionMode:'distance',distance:'10*pi/6'},p:[5*Math.sqrt(3),5,0]},
    {name:'quintic length plane',shape:'quintic',options:{fraction:.371},p:[3.71,0,0],n:[1,0,0]},
    {name:'fraction expression',shape:'quintic',type:'point',options:{fraction:'1/3'},p:[10/3,0,0]},
    {name:'fit spline point',shape:'fit',type:'point'},
    {name:'fit spline plane',shape:'fit'},
    {name:'closed circle seam plane',shape:'circle',options:{positionMode:'end'},p:[10,0,0],n:[0,1,0]},
    {name:'outside path reports conflict',options:{positionMode:'distance',distance:20},reject:true},
    {name:'cusp plane reports conflict',shape:'cusp',reject:true},
    {name:'cusp point is defined',shape:'cusp',type:'point',p:[0,0,0]},
    {name:'inactive expression is ignored',options:{positionMode:'start',fraction:'inactive',distance:'inactive'},p:[10,0,0],n:[0,1,0]},
    {name:'3D helix plane',source:'helix',options:{fraction:.25},p:[Math.sqrt(50),Math.sqrt(50),5],n:[-10*Math.PI/Math.sqrt(2)/Math.hypot(10*Math.PI,20),10*Math.PI/Math.sqrt(2)/Math.hypot(10*Math.PI,20),20/Math.hypot(10*Math.PI,20)]},
    {name:'3D helix point',source:'helix',type:'point',options:{fraction:.25},p:[Math.sqrt(50),Math.sqrt(50),5]},
    {name:'composite route distance crosses edge boundary',source:'route',options:{positionMode:'distance',distance:15},p:[10,5,0],n:[0,1,0]},
    {name:'route corner plane rejected',source:'route',options:{positionMode:'distance',distance:10},reject:true},
    {name:'route corner point is valid',source:'route',type:'point',options:{positionMode:'distance',distance:10},p:[10,0,0]},
    {name:'reverse route measured from end',source:'route',options:{positionMode:'distance',distance:5,reversePath:true},p:[10,15,0],n:[0,-1,0]},
    {name:'closed route seam plane rejected',source:'closedRoute',options:{positionMode:'start'},reject:true},
    {name:'closed route seam point is valid',source:'closedRoute',type:'point',options:{positionMode:'start'},p:[0,0,0]},
    {name:'circular CAD edge plane',source:'edgeCircle',options:{fraction:.25},length:20*Math.PI},
    {name:'circular CAD edge point',source:'edgeCircle',type:'point',options:{positionMode:'distance',distance:'5*pi'},length:20*Math.PI},
    {name:'spline CAD edge plane',source:'edgeSpline',options:{fraction:.5},p:[.5,1.5,0],n:[Math.SQRT1_2,Math.SQRT1_2,0],unsignedNormal:true},
    {name:'spline CAD edge point',source:'edgeSpline',type:'point',options:{fraction:.5},p:[.5,1.5,0]},
  ];
  try{await kernel.ready;
    for(const c of cases){
      const d=fixture(c.source==='edgeSpline'?'quadratic':c.source==='helix'||c.source==='edgeCircle'?'circle':c.shape||'arc',c.type||'plane',c.options);
      if(c.source==='helix'){
        const helix=M.createFeature(d.doc,'helix',{sketch:d.sk.id,definedBy:'heightRev',height:20,revolutions:.5,startAngle:0});d.doc.features.splice(-1,0,helix);d.feature.refs=[{kind:'curve',id:helix.id,relation:'alongPath',...c.options}];
      }else if(c.source==='route'||c.source==='closedRoute'){
        const route=M.createFeature(d.doc,'sketch3d',{segs:null,pts:[{x:0,y:0,z:0},{x:10,y:0,z:0},{x:10,y:20,z:0},...(c.source==='closedRoute'?[{x:0,y:20,z:0}]:[])],closed:c.source==='closedRoute',kind:'lines',radius:0});d.doc.features.splice(-1,0,route);d.feature.refs=[{kind:'curve',id:route.id,relation:'alongPath',...c.options}];
      }else if(c.source?.startsWith('edge')){
        if(c.source==='edgeSpline'){const curve=S.getCurve(d.sk,d.curve);S.addLine(d.sk,curve.p2,curve.p1);}
        const solid=M.createFeature(d.doc,'extrude',{sketch:d.sk.id,depth:5});d.doc.features.splice(-1,0,solid);
        const base=await kernel.rebuild({...d.doc,features:d.doc.features.slice(0,-1)});d.feature.refs=[{kind:'edge',body:base.body?.bodies?.[0]?.id,p:c.source==='edgeSpline'?[.5,1.5,0]:[10,0,0],relation:'alongPath',...c.options}];
      }
      const r=await kernel.rebuild(d.doc),info=r.info?.[d.feature.id],sample=info?.pathLocations?.[0],value=c.type==='point'?r.points[d.feature.id]:r.planes[d.feature.id];
      let ok=c.reject?info?.datum?.status==='conflict':!r.errors.length&&info?.datum?.status==='defined'&&!!sample;
      if(!c.reject&&sample){if(c.p)ok&&=close(sample.p,c.p,1e-6);if(c.n)ok&&=close(value.n,c.n,1e-6)||!!c.unsignedNormal&&close(value.n,c.n.map(x=>-x),1e-6);if(c.type==='point'&&c.p)ok&&=close(value,c.p,1e-6);if(c.type!=='point')ok&&=Math.abs(value.n.reduce((s,x,i)=>s+x*(sample.p[i]-value.o[i]),0))<2e-7;if(c.length)ok&&=Math.abs(sample.length-c.length)<1e-6;}
      if(!c.reject&&c.type!=='point'&&sample)ok&&=close(value.o,sample.p);
      results.push({name:c.name,ok,errors:r.errors,sample,value});
    }
    const changed=fixture('arc','point',{positionMode:'distance',distance:'10*pi/6'});await kernel.rebuild(changed.doc);S.getPoint(changed.sk,S.getCurve(changed.sk,changed.curve).p1).x=20;S.getPoint(changed.sk,S.getCurve(changed.sk,changed.curve).p2).y=20;
    const after=await kernel.rebuild(changed.doc),p=after.points[changed.feature.id],theta=Math.PI/12;
    results.push({name:'arc source edit retains real distance',ok:!after.errors.length&&close(p,[20*Math.cos(theta),20*Math.sin(theta),0]),errors:after.errors,p});
    const weighted=fixture('rational','point');await kernel.rebuild(weighted.doc);S.getCurve(weighted.sk,weighted.curve).weights=[1,1,1];const weightEdit=await kernel.rebuild(weighted.doc);
    results.push({name:'point follows rational weight edit',ok:!weightEdit.errors.length&&close(weightEdit.points[weighted.feature.id],[7.5,7.5,0]),errors:weightEdit.errors});
    const scaled=fixture('quintic','point',{fraction:.371});await kernel.rebuild(scaled.doc);const spline=S.getCurve(scaled.sk,scaled.curve);S.getPoint(scaled.sk,spline.pts.at(-1)).x=20;const scaledEdit=await kernel.rebuild(scaled.doc);
    results.push({name:'fraction follows changed spline length',ok:!scaledEdit.errors.length&&close(scaledEdit.points[scaled.feature.id],[7.42,0,0]),errors:scaledEdit.errors});
    const health=await kernel.stats();return {ok:results.every(r=>r.ok)&&!kernel.restarts,math,results,health};
  }finally{kernel.dispose();}
}
