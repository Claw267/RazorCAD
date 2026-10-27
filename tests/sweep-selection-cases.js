import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import * as LR from '/js/loftrefs.js';
import {KernelClient} from '/js/kernelclient.js';
import {fixture as baseFixture} from './sweep-guide-cases.js';
export function fixture({type='sweep',open=false,hole=false,guide=true,shared=false,junk=true}={}){
  const data=baseFixture('contact'),{doc,profile,path,sweep}=data;sweep.type=type;
  if(open){profile.points=[];profile.curves=[];profile.constraints=[];S.addLine(profile,S.addPoint(profile,-5,0),S.addPoint(profile,5,0));}
  if(hole)S.addCircle(profile,'O',2);
  sweep.profile=open?LR.chainRef(profile,profile.id,profile.curves[0].id):LR.regionRef(profile.id,LR.selectableRegions(profile).find(r=>r.outer.segs.some(g=>g.sourceCurve===profile.curves[0].id)));
  sweep.path=LR.chainRef(path,path.id,path.curves[0].id,true,true);
  let guideSketch=data.guide,guideCurve=guideSketch.curves[0];
  if(shared){const curve=S.addLine(path,S.addPoint(path,5,0),S.addPoint(path,10,100));doc.features=doc.features.filter(f=>f!==guideSketch);guideSketch=path;guideCurve=S.getCurve(path,curve);}
  sweep.guide=guide?LR.chainRef(guideSketch,guideSketch.id,guideCurve.id,true,true):null;
  if(junk){
    if(!open)S.addCircle(profile,S.addPoint(profile,30,0),2);
    S.addLine(path,S.addPoint(path,40,0),S.addPoint(path,40,100));
    if(!shared)S.addLine(guideSketch,S.addPoint(guideSketch,50,0),S.addPoint(guideSketch,50,100));
  }
  return {...data,guide:guideSketch,guideCurve};
}
const cone=Math.PI*100*175/3,cylinder=2500*Math.PI,coneArea=1500*Math.PI*Math.sqrt(1.0025);
export async function run({threads=1}={}){
  const kernel=new KernelClient({threads}),results=[];
  const cases=[
    {name:'selected profile path and guide ignore unrelated geometry',volume:cone},
    {name:'distinct path and guide contours in one sketch',shared:true,volume:cone},
    {name:'selected construction guide',volume:cone,edit:({guideCurve})=>{guideCurve.construction=true;}},
    {name:'selected construction path',volume:cone,edit:({path})=>{path.curves[0].construction=true;}},
    {name:'selected circle option ignores inactive profile',volume:cone,edit:({sweep})=>{sweep.profileType='circle';sweep.diameter=10;sweep.profile='missing';}},
    {name:'selected single path without guide',guide:false,volume:cylinder},
    {name:'selected profile with a hole',hole:true,guide:false,volume:2100*Math.PI},
    {name:'selected parallel orientation',guide:false,volume:cylinder,edit:({sweep})=>{sweep.orientation='parallel';sweep.twistAngle='inactive';}},
    {name:'selected twist',guide:false,volume:cylinder,edit:({sweep})=>{sweep.twistAngle=90;}},
    {name:'selected guide dimensional edit',volume:Math.PI*100*(25+60+144)/3,edit:({guide,guideCurve})=>{S.getPoint(guide,guideCurve.p2).x=12;}},
    {name:'overlapping cloned guide rejected',edit:({sweep})=>{sweep.guide=structuredClone(sweep.path);},reject:/different sources or entities/},
    {name:'overlapping profile and path rejected',edit:({sweep})=>{sweep.path=structuredClone(sweep.profile);},reject:/different entities/},
    {name:'whole source overlaps selected contour',shared:true,edit:({sweep,path})=>{sweep.path=path.id;},reject:/different sources or entities/},
    {name:'deleted selected path entity rejected',edit:({path})=>{path.curves.splice(0,1);},reject:/selected curve was deleted/},
    {name:'missing selected guide rejected',edit:({sweep})=>{sweep.guide.sketch='missing';},reject:/guide is missing/},
    {name:'branched whole path stays explicit',edit:({sweep,path})=>{sweep.path=path.id;},reject:/one connected chain/},
    {name:'guided holes remain unsupported',hole:true,reject:/without holes or Thin/},
    {name:'selected closed surface stays a surface',type:'surfSweep',area:coneArea},
    {name:'selected open surface',type:'surfSweep',open:true,area:1500},
    {name:'selected surface without guide',type:'surfSweep',guide:false,area:1000*Math.PI},
    {name:'surface path and guide in one sketch',type:'surfSweep',shared:true,area:coneArea},
    {name:'surface direction retains parallel',type:'surfSweep',guide:false,area:1000*Math.PI,edit:({sweep})=>{sweep.orientation='parallel';}},
    {name:'surface twist retains selected contour',type:'surfSweep',guide:false,area:1000*Math.PI,edit:({sweep})=>{sweep.twistAngle=90;}},
  ];
  try{await kernel.ready;for(const c of cases){
    const data=fixture(c);c.edit?.(data);const r=await kernel.rebuild(data.doc),item={name:c.name,errors:r.errors,ok:false};
    if(c.reject)item.ok=r.errors.some(([,e])=>c.reject.test(e));
    else if(!r.errors.length){const b=r.body.bodies.at(-1),m=await kernel.request('measure',{refs:[{kind:'body',id:b.id}]});item.measure=m.items[0];const key=c.volume?'volume':'area';item.ok=item.measure.solid===(data.sweep.type==='sweep')&&Math.abs(item.measure[key]-c[key])/c[key]<2e-5;}
    results.push(item);
  }const health=await kernel.stats();return {ok:results.every(r=>r.ok)&&!kernel.restarts&&health.memoryMB<512,results,health};}finally{kernel.dispose();}
}
