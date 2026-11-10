import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createCanvas} from '@napi-rs/canvas';
import {AuditService} from '../src/service.js';
import {Config,createToolDefinitions} from '../src/plugin.js';
import {readRuntimeConfig} from '../src/runtime-settings.js';
import {builtInSettings,defaultsFromConfig,validateSettings} from '../src/settings.js';
import {defaultProfile} from '../src/profiles.js';
async function setup(t,defaults={}){
 const root=await mkdtemp(path.join(tmpdir(),'audit-settings-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const options={dataDir:path.join(root,'data'),allowedRoots:[root],defaults},service=await new AuditService(options).init(),p=await service.createProject({name:'settings fixture'});
 const add=async(name,text,role)=>{const file=path.join(root,name);await writeFile(file,text);await service.addDocument({projectId:p.id,filePath:file,role});return (await service.getProject(p.id)).documents.at(-1);};
 return{root,service,p,options,add};
}
const fixture='Compound 3a: 1H NMR (400 MHz, CDCl3) δ 7.123 (s, 2H). HRMS (ESI) m/z: [M+H]+ calcd for C2H6O 47.0491; found 48.0491.';
const noChecks=Object.fromEntries(Object.keys(builtInSettings().checks).map(k=>[k,false]));
test('native Config exposes validated defaults and custom decimal profile without invented journal',()=>{
 const defaults=defaultsFromConfig(readRuntimeConfig(Config({})).defaults);assert.deepEqual(defaults,builtInSettings());
 const custom=defaultsFromConfig(readRuntimeConfig(Config({defaults:{formatting:{enabled:true,h1Digits:4,c13Digits:3}}})).defaults);
 assert.equal(custom.profile.rules[0].number_format.digits,4);assert.equal(custom.profile.rules[1].number_format.digits,3);assert.equal(custom.profile.profile.journal,null);assert.equal(custom.profile.profile.source_type,'user_defined');
 assert.throws(()=>defaultsFromConfig({formatting:{enabled:true,h1Digits:2.5}}));
 assert.throws(()=>validateSettings({hrms:{formulaBasis:'neutral'}}));
 assert.throws(()=>validateSettings({visual:{maxPairs:0}}));
 assert.throws(()=>validateSettings({checks:{nmr:'false'}}));
 assert.throws(()=>defaultsFromConfig({imageTypeRulesJson:'broken'}));
 assert.throws(()=>validateSettings(JSON.parse('{"__proto__":{}}')));
 const profile=defaultProfile();profile.profile.name='Explicit profile';assert.equal(defaultsFromConfig({formatting:{enabled:true,profileText:JSON.stringify(profile)}}).profile.rules.length,0);
});
test('global changes only affect new projects; project and task overrides survive restart and reset',async t=>{
 const{service,p,options}=await setup(t,{scope:'si',hrms:{ppmTolerance:8,mDaTolerance:2}});
 const next=await new AuditService({...options,defaults:{scope:'all',hrms:{ppmTolerance:15}}}).init();
 assert.equal((await next.getSettings({projectId:p.id})).effective.hrms.ppmTolerance,8);
 const q=await next.createProject({name:'new'});assert.equal((await next.getSettings({projectId:q.id})).effective.hrms.ppmTolerance,15);
 await next.configureSettings({projectId:p.id,settings:{scope:'all',hrms:{mDaTolerance:null}}});
 const preview=await service.getSettings({projectId:p.id,settings:{hrms:{ppmTolerance:4}}});
 assert.equal(preview.effective.hrms.ppmTolerance,4);assert.equal(preview.projectEffective.hrms.ppmTolerance,8);assert.equal(preview.effective.hrms.mDaTolerance,null);
 assert.equal((await service.getSettings({projectId:p.id})).effective.scope,'all');
 await service.configureSettings({projectId:p.id,reset:true});assert.equal((await service.getSettings({projectId:p.id})).effective.scope,'si');
 assert.equal((await service.getProject(p.id)).settingsHistory.length,2);
 await assert.rejects(service.configureSettings({projectId:p.id,reset:true,settings:{scope:'all'}}));
});
test('legacy project keeps existing tolerances and format when new plugin defaults change',async t=>{
 const{service,p,options}=await setup(t);const old=await service.getProject(p.id);delete old.settingsSnapshot;delete old.settingsOverrides;delete old.settingsRevision;old.hrmsOptions.ppmTolerance=7;
 await writeFile(path.join(service.dir(p.id),'project.json'),JSON.stringify(old));
 const current=await new AuditService({...options,defaults:{scope:'si',hrms:{ppmTolerance:20}}}).init();
 let settings=await current.getSettings({projectId:p.id});assert.equal(settings.effective.scope,'all');assert.equal(settings.effective.hrms.ppmTolerance,7);assert.equal(settings.inheritance,'legacy_project_and_0.8_defaults');
 await current.configureSettings({projectId:p.id,settings:{report:{format:'csv'}}});await current.configureSettings({projectId:p.id,reset:true});
 settings=await current.getSettings({projectId:p.id});assert.equal(settings.effective.hrms.ppmTolerance,7);assert.equal(settings.effective.scope,'all');
});
test('scoped task excludes main, disables checks explicitly and freezes tolerances without changing project',async t=>{
 const{service,p,add}=await setup(t);await add('main.txt','Compound 3a: yield: 80%.','main');await add('si.txt',fixture,'si');
 const run=await service.runAudit({projectId:p.id,settings:{scope:'si',checks:noChecks,hrms:{ppmTolerance:12}}});
 assert.deepEqual(run.documents.map(d=>d.role),['si']);assert.deepEqual(run.coverage.missingRoles,[]);assert.equal(run.coverage.settingsScope.excludedSources.length,1);
 for(const key of ['hrms','nmrFormula','imageDuplicates','visualAgentReview','experimentalMath','experimentalProse','crossReferences','stoichiometry','spectrumComparison'])assert.equal(run.coverage[key].status,'disabled',key);
 assert.equal(run.coverage.completedChecks.includes('hrms_conditional_exact_mass_recalculation'),false);assert.equal(run.issues.some(i=>['hrms','nmr_formula','image_duplicate'].includes(i.category)),false);
 assert.equal((await service.getSettings({projectId:p.id})).effective.hrms.ppmTolerance,5);
 assert.equal((await service.getRun({projectId:p.id})).sourcesChangedSinceRun,false);
 await service.configureSettings({projectId:p.id,settings:{hrms:{ppmTolerance:9}}});const saved=await service.getRun({projectId:p.id,runId:run.id});assert.equal(saved.appliedSettings.effective.hrms.ppmTolerance,12);assert.equal(saved.settingsChangedSinceRun,true);
});
test('HRMS extraction still supports NMR when HRMS alerts are disabled',async t=>{
 const{service,p,add}=await setup(t);await add('si.txt',fixture,'si');const run=await service.runAudit({projectId:p.id,settings:{checks:{hrms:false}}});
 assert.ok(run.hrmsRecords.length);assert.equal(run.coverage.hrms.dependencyExtraction,true);assert.equal(run.issues.some(i=>i.category==='hrms'),false);assert.equal(run.coverage.completedChecks.includes('hrms_conditional_exact_mass_recalculation'),false);
});
test('task-only disabled checks cannot close a previous issue',async t=>{
 const{service,p,add}=await setup(t);await add('si.txt',fixture,'si');const before=await service.runAudit({projectId:p.id});assert.ok(before.issues.some(i=>i.category==='hrms'));
 const after=await service.runAudit({projectId:p.id,settings:{checks:noChecks}});const disappeared=after.revisionLedger.items.filter(i=>!i.currentIssueId);assert.ok(disappeared.length);assert.ok(disappeared.every(i=>i.state==='cannot_revalidate'&&i.gaps.includes('settings_changed')));
});
test('default report format uses run snapshot; CSV includes settings sidecar and JSON keeps evidence',async t=>{
 const{service,p,add}=await setup(t,{report:{format:'csv',includeEvidence:false,includeImages:false}});await add('si.txt',fixture,'si');const run=await service.runAudit({projectId:p.id});
 await service.configureSettings({projectId:p.id,settings:{report:{format:'json'}}});const csv=await service.exportReport({projectId:p.id,runId:run.id});assert.equal(csv.format,'csv');const metadata=JSON.parse(await readFile(csv.settingsPath,'utf8'));assert.equal(metadata.appliedSettings.effective.report.format,'csv');
 const json=await service.exportReport({projectId:p.id,format:'json'});assert.ok(JSON.parse(json.content).documents[0].blocks.length);
 const md=await service.exportReport({projectId:p.id,format:'md'});assert.match(md.content,/本次实际设置/);assert.match(md.content,/旧快照/);assert.equal(md.content.includes('![疑似重复区域对照]'),false);
 await assert.rejects(service.exportReport({projectId:p.id,includeImages:'false'}));
});
async function images(t,defaults={}){const f=await setup(t,defaults),c=createCanvas(120,90),x=c.getContext('2d');x.fillStyle='white';x.fillRect(0,0,120,90);x.fillStyle='black';x.fillRect(10,10,40,40);for(const role of ['main','si']){const d=await f.add(role+'.png',c.toBuffer('image/png'),role);await f.service.prepareVisuals({projectId:f.p.id,documentKey:d.key});}return f;}
test('visual queue inherits SI scope and budgets, records exclusions and rejects scope escape',async t=>{
 const{service,p}=await images(t,{scope:'si',visual:{maxPairs:1}});const job=await service.visualReview({projectId:p.id,action:'start'});assert.equal(job.coverage.selectedAssets,1);assert.equal(job.coverage.scheduledPairs,1);assert.equal(job.coverage.excludedAssets[0].reason,'outside_settings_scope');
 const main=(await service.getProject(p.id)).visualAssets.find(a=>a.role==='main');await assert.rejects(service.visualReview({projectId:p.id,action:'start',options:{assetIds:[main.id]}}),/outside settings scope/);
 await service.configureSettings({projectId:p.id,settings:{checks:{visualReview:false}}});assert.equal((await service.visualReview({projectId:p.id})).status,'stale');await assert.rejects(service.visualReview({projectId:p.id,action:'start'}),/disabled/);
 const override=await service.visualReview({projectId:p.id,action:'start',settings:{checks:{visualReview:true},scope:'all'},options:{maxPairs:2}});assert.equal(override.coverage.scheduledPairs,2);
 const run=await service.runAudit({projectId:p.id,settings:{checks:{visualReview:true}}});assert.equal(run.coverage.visualAgentReview.status,'outside_run_scope');
});
test('workflow freezes scope/OCR and resumes after service restart; project changes make it stale',async t=>{
 const{service,p,options}=await images(t,{scope:'si',workflow:{ocr:false,maxSteps:1}});
 const job=await service.workflow({projectId:p.id,action:'start'});assert.equal(job.documents.length,1);assert.equal(job.excludedDocuments.length,1);assert.equal(job.ocr,false);
 const restarted=await new AuditService({...options,defaults:{workflow:{ocr:true,maxSteps:25}}}).init();let saved=await restarted.workflow({projectId:p.id,action:'resume'});assert.equal(saved.ocr,false);assert.equal(saved.appliedSettings.effective.workflow.maxSteps,1);
 await assert.rejects(service.workflow({projectId:p.id,action:'resume',settings:{scope:'all'}}),/start-only/);
 await service.configureSettings({projectId:p.id,settings:{scope:'all'}});assert.equal((await service.workflow({projectId:p.id})).status,'stale');
});
test('workflow passes task overrides through to final audit and does not silently reuse different job',async t=>{
 const{service,p,add}=await setup(t);await add('main.txt','Compound 3a: yield: 80%.','main');await add('si.txt',fixture,'si');
 const job=await service.workflow({projectId:p.id,action:'start',settings:{scope:'si',checks:noChecks,workflow:{ocr:false}}});assert.ok(job.latestRunId);const run=await service.getRun({projectId:p.id,runId:job.latestRunId});assert.equal(run.appliedSettings.effective.scope,'si');assert.equal(run.coverage.hrms.status,'disabled');
});
test('native settings tools preview and configure preferences and report model capability without credentials',async t=>{
 const{service,p}=await setup(t);const bridge={ctx:{get:k=>k==='llm'?{resolveModelInfo:async()=>({inputModalities:['image','text'],apiKey:'never-return'})}:k==='attachments'?{imageLimits:{mediaTypes:['image/png']}}:null}};
 const defs=createToolDefinitions(service,bridge),exec={signal:new AbortController().signal,modelSelection:{provider:'fixture',model:'vision'}};
 await defs.find(x=>x.name==='paper_audit_configure_settings').execute({projectId:p.id,settingsJson:'{"scope":"si"}'},exec);
 const result=await defs.find(x=>x.name==='paper_audit_settings').execute({projectId:p.id,settingsJson:'{"scope":"all"}'},exec);assert.equal(result.effective.scope,'all');assert.equal(result.projectEffective.scope,'si');assert.equal(result.modelStatus.acceptsImages,true);assert.equal(JSON.stringify(result).includes('never-return'),false);
});
