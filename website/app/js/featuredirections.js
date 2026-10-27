// Shared interval semantics for solid and surface feature directions.
const positive=(value,label)=>{if(!Number.isFinite(value)||value<=0)throw new Error(`${label} must be finite and greater than zero`);return value;};
const nonnegative=(value,label)=>{if(!Number.isFinite(value)||value<0)throw new Error(`${label} must be finite and nonnegative`);return value;};
export function extrusionInterval(f,evaluate){
  const mode=f.end||'blind',depth=positive(evaluate(f.depth),'Depth');let start=0,end=depth;
  if(mode==='midplane'){start=-depth/2;end=depth/2;}
  else if(mode==='twoSides')start=-nonnegative(evaluate(f.depth2??0),'Second depth');
  else if(mode!=='blind')throw new Error('Select a supported extrusion direction');
  if(f.reverse&&mode!=='midplane')[start,end]=[-end,-start];
  return {start,end};
}
export function revolutionInterval(f,evaluate){
  if(f.extent==='full')return {start:0,angle:360};
  if(f.extent&&f.extent!=='angle')throw new Error('Select Full or Angle for the revolution extent');
  let first=positive(evaluate(f.angle),'Angle');
  // Old files used a clamped angle; preserve that existing geometry.
  if(!f.extent)first=Math.min(first,360);
  const mode=f.end||'oneway',second=mode==='twoSides'?nonnegative(evaluate(f.angle2??0),'Second angle'):0,angle=first+second;
  if(angle>360+1e-9)throw new Error('The total revolution angle must not exceed 360 degrees');
  if(!['oneway','midplane','twoSides'].includes(mode))throw new Error('Select a supported revolution direction');
  const start=mode==='midplane'?-angle/2:f.reverse?-first:-second;
  return {start,angle};
}
