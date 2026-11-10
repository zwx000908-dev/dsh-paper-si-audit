import { validateScientificConfig } from './scientific-config.js';
import { defaultProfile, validateProfile, parseProfile } from './profiles.js';
const plain=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
export function mergeSettings(base,patch={}) {
  if(!plain(patch))throw new Error('Settings patch must be an object');
  const out=structuredClone(base);
  for(const [key,value] of Object.entries(patch)){
    if(['__proto__','prototype','constructor'].includes(key))throw new Error('Invalid settings key');
    out[key]=key!=='profile'&&plain(value)&&plain(out[key])?mergeSettings(out[key],value):structuredClone(value);
  }
  return out;
}
export function builtInSettings(){return {scope:'all',checks:{crossDocument:true,stoichiometry:true,hrms:true,nmr:true,experiments:true,crossReferences:true,pixelDuplicates:true,visualReview:true},profile:defaultProfile(),scientific:validateScientificConfig(),hrms:{ppmTolerance:5,mDaTolerance:null},workflow:{ocr:false,maxSteps:3},visual:{mode:'all',includeSelf:true,maxAssets:200,maxPairs:2000},report:{format:'md',includeImages:true,includeEvidence:true}};}
function keys(obj,allowed){if(!plain(obj)||Object.keys(obj).some(k=>!allowed.includes(k)))throw new Error('Unknown or invalid settings field');}
function num(v,min,max,integer=false){if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max||(integer&&!Number.isInteger(v)))throw new Error('Setting outside allowed bounds');}
export function validateSettings(input){
  const defaults=builtInSettings();keys(input,Object.keys(defaults));const r=mergeSettings(defaults,input);
  if(!['all','si'].includes(r.scope))throw new Error('scope must be all or si');
  keys(r.checks,Object.keys(defaults.checks));for(const v of Object.values(r.checks))if(typeof v!=='boolean')throw new Error('Check toggles must be boolean');
  r.profile=validateProfile(r.profile);r.scientific=validateScientificConfig(r.scientific);
  keys(r.hrms,['ppmTolerance','mDaTolerance']);num(r.hrms.ppmTolerance,.001,10000);if(r.hrms.mDaTolerance!==null)num(r.hrms.mDaTolerance,.001,1000);
  keys(r.workflow,['ocr','maxSteps']);if(typeof r.workflow.ocr!=='boolean')throw new Error('ocr must be boolean');num(r.workflow.maxSteps,1,25,true);
  keys(r.visual,['mode','includeSelf','maxAssets','maxPairs']);if(!['all','same_type'].includes(r.visual.mode)||typeof r.visual.includeSelf!=='boolean')throw new Error('Invalid visual defaults');num(r.visual.maxAssets,1,500,true);num(r.visual.maxPairs,1,10000,true);
  keys(r.report,['format','includeImages','includeEvidence']);if(!['md','json','csv'].includes(r.report.format)||typeof r.report.includeImages!=='boolean'||typeof r.report.includeEvidence!=='boolean')throw new Error('Invalid report defaults');
  return r;
}
function legacySettings(){const s=builtInSettings();s.workflow.ocr=true;return s;}
export function projectSettings(p){
  const base=p.settingsSnapshot??legacySettings();
  const current=mergeSettings(base,p.settingsOverrides??{});
  current.profile=p.profile??current.profile;current.scientific=p.scientificOptions??current.scientific;
  current.hrms={ppmTolerance:p.hrmsOptions?.ppmTolerance??current.hrms.ppmTolerance,mDaTolerance:p.hrmsOptions && Object.hasOwn(p.hrmsOptions,'mDaTolerance') ? p.hrmsOptions.mDaTolerance : current.hrms.mDaTolerance};
  return validateSettings(current);
}
export function resolveSettings(p,patch={}){
  const project=projectSettings(p),effective=validateSettings(mergeSettings(project,patch));
  return {effective,projectEffective:project,projectRevision:p.settingsRevision??0,inheritance:p.settingsSnapshot?'plugin_defaults_captured_at_creation':'legacy_project_and_0.8_defaults',projectDefaults:structuredClone(p.settingsSnapshot??legacySettings()),projectOverrides:structuredClone(p.settingsOverrides??{}),taskOverrides:structuredClone(patch),note:'Captured defaults -> project settings -> task patch. Scientific interpretations and model credentials are not settings defaults.'};
}
export function auditSettingsKey(s){const{scope,checks,profile,scientific,hrms}=s;return JSON.stringify({scope,checks,profile,scientific,hrms});}
export function defaultsFromConfig(config={}){
  const {formatting={},imageTypeRulesJson,...rest}=config;
  keys(formatting,['enabled','h1Digits','c13Digits','couplingDigits','hrmsDigits','profileText']);
  if(formatting.enabled!==undefined && typeof formatting.enabled!=='boolean')throw new Error('formatting.enabled must be boolean');
  if(formatting.profileText!==undefined && typeof formatting.profileText!=='string')throw new Error('profileText must be text');
  if(imageTypeRulesJson!==undefined && typeof imageTypeRulesJson!=='string')throw new Error('imageTypeRulesJson must be text');
  const s=validateSettings(rest);
  if(imageTypeRulesJson?.trim())s.scientific.imageTypeRules=JSON.parse(imageTypeRulesJson);
  if(formatting.profileText?.trim())s.profile=parseProfile(formatting.profileText);
  else if(formatting.enabled){
    const fields=[['h1Digits','nmr.h1.chemical_shift',2],['c13Digits','nmr.c13.chemical_shift',1],['couplingDigits','nmr.coupling_constant',1],['hrmsDigits','hrms.mass_to_charge',4]];
    s.profile={schema_version:1,profile:{id:'settings-decimals',name:'用户设置的小数位模板（非期刊标准）',version:'1.0.0',source_type:'user_defined',journal:null},rules:fields.map(([key,field,fallback])=>{const digits=formatting[key]??fallback;num(digits,0,10,true);return{id:key,field,scope:'si.characterization',number_format:{mode:'decimal_places',digits,rounding:'half_up'}};})};
  }
  return validateSettings(s);
}
