import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import {KernelClient} from '/js/kernelclient.js';
export function fixture(options={}){
  const doc=M.newDoc(),plane=M.createFeature(doc,'plane',{refs:[{kind:'plane',id:'front'}],offset:5});doc.features.push(plane);
  const sk=M.createFeature(doc,'sketch',{plane:{ref:'front'}});S.addCircle(sk,'O',2);doc.features.push(sk);
  const feature=M.createFeature(doc,'extrude',{sketch:sk.id,depth:10,...options});doc.features.push(feature);return {doc,plane,sk,feature};
}
function tilt(d){const s=M.createFeature(d.doc,'sketch',{plane:{ref:d.plane.id}}),line=S.addLine(s,S.addPoint(s,0,-10),S.addPoint(s,0,10)),p=M.createFeature(d.doc,'plane',{referenceDefinition:true,refs:[{kind:'sketch',sketch:s.id,curve:line,relation:'coincident'},{kind:'plane',id:'front',relation:'angle',angle:30}]});d.doc.features.splice(-1,0,s,p);return p;}
export function base(d){const sk=M.createFeature(d.doc,'sketch',{plane:{ref:'front'}}),p=[[-10,-10],[10,-10],[10,10],[-10,10]].map(q=>S.addPoint(sk,...q));p.forEach((id,i)=>S.addLine(sk,id,p[(i+1)%4]));const solid=M.createFeature(d.doc,'extrude',{sketch:sk.id,depth:20});d.doc.features.unshift(sk,solid);return solid;}
export async function run({threads=1}={}){
  const k=new KernelClient({threads}),results=[];await k.ready;
  try{
    const cases=[
      {name:'legacy profile start',options:{},volume:40*Math.PI,probes:[[0,0,0],[0,0,10]]},
      {name:'offset expression',options:{startFrom:'offset',startOffset:'2+3'},volume:40*Math.PI,probes:[[0,0,5],[0,0,15]]},
      {name:'negative offset reverse',options:{startFrom:'offset',startOffset:-5,reverse:true},volume:40*Math.PI,probes:[[0,0,-5],[0,0,-15]]},
      {name:'offset symmetric',options:{startFrom:'offset',startOffset:5,end:'midplane'},volume:40*Math.PI,probes:[[0,0,0],[0,0,10]]},
      {name:'offset two sides',options:{startFrom:'offset',startOffset:5,end:'twoSides',depth2:3},volume:52*Math.PI,probes:[[0,0,2],[0,0,15]]},
      {name:'start plane',options:{startFrom:'surface'},edit:d=>{d.feature.startPlane=d.plane.id;},volume:40*Math.PI,probes:[[0,0,5],[0,0,15]]},
      {name:'independent start and end planes',options:{startFrom:'offset',startOffset:2,end:'upToSurface'},edit:d=>{d.feature.toPlane=d.plane.id;},volume:12*Math.PI,probes:[[0,0,2],[0,0,5]]},
      {name:'offset end plane',options:{startFrom:'offset',startOffset:2,end:'offsetSurface',toOffset:1},edit:d=>{d.feature.toPlane=d.plane.id;},volume:8*Math.PI,probes:[[0,0,2],[0,0,4]]},
      {name:'inactive invalid start ignored',options:{startFrom:'profile',startOffset:'missing',startPlane:'missing'},volume:40*Math.PI},
      {name:'missing start object rejected',options:{startFrom:'surface'},reject:true},
      {name:'parallel start plane rejected',options:{startFrom:'surface',startPlane:'right'},reject:true},
      {name:'tilted start with blind distance',options:{startFrom:'surface'},edit:d=>{d.feature.startPlane=tilt(d).id;},volume:40*Math.PI,probes:[[0,0,5],[0,0,15]]},
      {name:'tilted reverse',options:{startFrom:'surface',reverse:true},edit:d=>{d.feature.startPlane=tilt(d).id;},volume:40*Math.PI,probes:[[0,0,5],[0,0,-5]]},
      {name:'tilted start to independent end',options:{startFrom:'surface',end:'upToSurface'},edit:d=>{d.feature.startPlane=tilt(d).id;const p=M.createFeature(d.doc,'plane',{refs:[{kind:'plane',id:'front'}],offset:15});d.doc.features.splice(-1,0,p);d.feature.toPlane=p.id;},volume:40*Math.PI,probes:[[0,0,5],[0,0,15]]},
      {name:'crossing start and end rejected',options:{startFrom:'surface',end:'upToSurface'},edit:d=>{d.feature.startPlane=tilt(d).id;d.feature.toPlane=d.plane.id;},reject:true},
      {name:'cut from offset',options:{op:'cut',startFrom:'offset',startOffset:5},edit:base,volume:8000-40*Math.PI},
      {name:'through from offset',options:{op:'cut',startFrom:'offset',startOffset:5,end:'through'},edit:base,volume:8000-60*Math.PI},
      {name:'reverse through from offset',options:{op:'cut',startFrom:'offset',startOffset:5,end:'through',reverse:true},edit:base,volume:8000-20*Math.PI},
      {name:'start on model face',options:{startFrom:'surface',startFace:{p:[0,0,20],n:[0,0,1]},merge:false},edit:base,volume:40*Math.PI,probes:[[0,0,20],[0,0,30]]},
      {name:'thin offset start',options:{startFrom:'offset',startOffset:3,thin:true,thinT:1,thinDir:'one'},volume:50*Math.PI,probes:[[2,0,3],[2,0,13]]},
      {name:'tilted start through cut',options:{op:'cut',startFrom:'surface',end:'through'},edit:d=>{base(d);d.feature.startPlane=tilt(d).id;},volume:8000-60*Math.PI},
    ];
    for(const c of cases){const d=fixture(c.options);c.edit?.(d);const r=await k.rebuild(d.doc);if(c.reject){results.push({name:c.name,ok:!!r.errors.length,errors:r.errors});continue;}
      const body=r.body?.bodies?.at(-1);if(r.errors.length||!body){results.push({name:c.name,ok:false,errors:r.errors});continue;}
      const measurement=(await k.request('measure',{refs:[{kind:'body',id:body.id}]})).items[0];let ok=Math.abs(measurement.volume-c.volume)<1e-4;
      for(const p of c.probes||[]){const m=await k.request('measure',{refs:[{kind:'vertex',p},{kind:'body',id:body.id}]});ok&&=Math.abs(m.distance)<1e-5;}
      results.push({name:c.name,ok,volume:measurement.volume});
    }
    const linked=fixture({startFrom:'surface'});linked.feature.startPlane=linked.plane.id;await k.rebuild(linked.doc);linked.plane.offset=7;const rebuilt=await k.rebuild(linked.doc),bid=rebuilt.body?.bodies?.at(-1)?.id;
    const contact=bid&&await k.request('measure',{refs:[{kind:'vertex',p:[0,0,7]},{kind:'body',id:bid}]});results.push({name:'linked start plane edit',ok:!rebuilt.errors.length&&!!bid&&contact.distance<1e-6&&M.referencesOf(linked.doc,linked.feature).has(linked.plane.id)});
    return {ok:results.every(r=>r.ok),results};
  }finally{k.worker.terminate();}
}
