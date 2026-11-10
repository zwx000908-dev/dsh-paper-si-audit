import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {updateVolatile} from '@deepseek-ai/cosmokit';
import {Config} from '../src/settings-schema.js';
import {createRuntimeService,readRuntimeConfig} from '../src/runtime-settings.js';
import {PaperSettingsController} from '../src/settings-controller.js';
import {AuditService} from '../src/service.js';
import {createCanvas} from '@napi-rs/canvas';
import {resolveSettings} from '../src/settings.js';
import {apply} from '../src/plugin.js';
const base=async t=>{const root=await mkdtemp(path.join(tmpdir(),'paper-native-settings-'));t.after(()=>rm(root,{recursive:true,force:true}));return{root,dataDir:path.join(root,'data'),allowedRoots:[root]};};
test('all native settings roots are live; legacy OCR preference remains unchanged',()=>{
 for(const field of ['dataDir','allowedRoots','defaults'])assert.equal(Config.dict[field].meta.volatile,true);
 assert.equal(readRuntimeConfig(Config({})).defaults.workflow.ocr,false);
 assert.equal(resolveSettings({}).effective.workflow.ocr,true);
 const previous=readRuntimeConfig(Config({defaults:{workflow:{ocr:true}}}));assert.equal(resolveSettings({settingsSnapshot:{...resolveSettings({}).effective,workflow:previous.defaults.workflow}}).effective.workflow.ocr,true);
});
test('live Config reference updates reach subsequent tools and new projects without rewriting old project',async t=>{
 const config=Config(await base(t)),service=createRuntimeService(config);await service.init();const p=await service.createProject({name:'before'});
 const next=Config({...readRuntimeConfig(config),defaults:{scope:'si',hrms:{ppmTolerance:3}}});updateVolatile(config.defaults,next.defaults);
 assert.equal((await service.getSettings()).pluginDefaults.scope,'si');assert.equal((await service.getSettings({projectId:p.id})).effective.scope,'all');
 const q=await service.createProject({name:'after'});assert.equal(q.settingsSnapshot.hrms.ppmTolerance,3);
});
test('settings endpoint checks owner, validates advanced templates and sends revision-fenced native edits',async t=>{
 const section=readRuntimeConfig(Config(await base(t)));let writes=[];const controller={ctx:{invocation:{peer:{principal:{kind:'owner'}}},settings:{mutate:async(...a)=>writes.push(a)}}};
 await PaperSettingsController.prototype.save.call(controller,section,4);assert.equal(writes.length,1);assert.equal(writes[0][0],'paper-si-audit');assert.equal(writes[0][2],4);
 await assert.rejects(PaperSettingsController.prototype.save.call(controller,{...section,defaults:{formatting:{profileText:'broken: [yaml'}}},4));assert.equal(writes.length,1);
 await assert.rejects(PaperSettingsController.prototype.save.call(controller,section,undefined));controller.ctx.invocation.peer.principal.kind='guest';await assert.rejects(PaperSettingsController.prototype.save.call(controller,section,4));assert.equal(writes.length,1);
});
test('invalid directories are rejected before saving, without creating output folders',async t=>{
 const options=await base(t),section=readRuntimeConfig(Config(options));
 const file=path.join(options.root,'not-a-directory.txt');await writeFile(file,'fixture');
 let writes=0;const controller={ctx:{invocation:{peer:{principal:{kind:'owner'}}},settings:{mutate:async()=>{writes++;}}}};
 for(const invalid of [
  {...section,allowedRoots:[path.join(options.root,'missing')]},
  {...section,allowedRoots:[file]},
  {...section,dataDir:file},
  {...section,dataDir:path.join(file,'child')},
 ])await assert.rejects(PaperSettingsController.prototype.save.call(controller,invalid,1),/目录|文件夹/);
 assert.equal(writes,0);
 await assert.rejects(access(section.dataDir),{code:'ENOENT'});
 await PaperSettingsController.prototype.save.call(controller,section,1);
 await PaperSettingsController.prototype.save.call(controller,{...section,allowedRoots:[]},2);
 assert.equal(writes,2);
 await assert.rejects(access(section.dataDir),{code:'ENOENT'});
});
test('missing source directories do not block settings registration; live repair restores tools',async t=>{
 const options=await base(t),config=Config({...options,allowedRoots:[path.join(options.root,'gone')]});
 let settingsHook;const registered=[];
 await apply({inject:(_names,fn)=>{settingsHook=fn;},tools:{register:t=>registered.push(t)},systemPrompt:{section(){}}},config);
 assert.equal(typeof settingsHook,'function');assert.equal(registered.length,47);
 const execute=()=>registered.find(t=>t.name==='paper_audit_projects').execute({},{signal:new AbortController().signal});
 await assert.rejects(execute(),/设置 → 论文核对/);
 updateVolatile(config.allowedRoots,Config(options).allowedRoots);
 assert.deepEqual(await execute(),{projects:[]});
 // A source folder can also disappear while the process stays running.
 updateVolatile(config.allowedRoots,Config({...options,allowedRoots:[path.join(options.root,'gone-again')]}).allowedRoots);
 await assert.rejects(execute(),/设置 → 论文核对/);
 updateVolatile(config.allowedRoots,Config(options).allowedRoots);
 assert.deepEqual(await execute(),{projects:[]});
});
test('client module registers visible settings section and saves through validated endpoint',async()=>{
 let loaded,registration,sent;const form={};vm.runInNewContext(await readFile(new URL('../client/index.js',import.meta.url),'utf8'),{window:{__ModuleLoader__:{load:v=>loaded=v}},structuredClone});
 const plugin=loaded.factory(name=>{assert.equal(name,'react');return {createElement(){}}});assert.equal(loaded.id,'dsh-paper-si-audit');
 plugin.apply({effect:fn=>fn(),configForms:{get:id=>{assert.equal(id,'paper-si-audit');return form;}},slots:{inject:(name,fn)=>fn(),register:(options,page)=>{registration={options,page};return()=>{};}},connection:{rpc:{call:async(...args)=>{sent=args;return{ok:true,value:{saved:true}};}}}});
 assert.equal(registration.options.name,'settings.section');assert.equal(registration.options.label(),'论文核对');const props=registration.options.inject();assert.equal(props.form,form);await props.save({defaults:{scope:'si'}},12);assert.equal(sent[1],'paperAuditSettings/save');assert.equal(sent[2].args.expectedRevision,12);
});
async function imageProject(t){const options=await base(t),service=await new AuditService(options).init(),p=await service.createProject({name:'multimodal'});const c=createCanvas(90,90),x=c.getContext('2d');x.fillStyle='white';x.fillRect(0,0,90,90);x.fillStyle='black';x.fillRect(10,10,35,35);const file=path.join(options.root,'figure.png');await writeFile(file,c.toBuffer('image/png'));await service.addDocument({projectId:p.id,filePath:file,role:'si'});return{service,p};}
test('new workflow prepares original images without OCR and explicitly hands off multimodal review',async t=>{
 const{service,p}=await imageProject(t);service.readMaterialImage=async()=>{throw new Error('OCR must not be called')};const job=await service.workflow({projectId:p.id,action:'start',maxSteps:10});assert.equal(job.ocr,false);assert.equal(job.tasks[0].status,'rendered');assert.equal(job.reviewHandoff.primaryMethod,'multimodal_source_images');assert.equal(job.reviewHandoff.modelReviewPerformedByWorkflow,false);assert.equal(job.reviewHandoff.preparedAssetIds.length,1);assert.equal((await service.getVisualImage({projectId:p.id,assetId:job.reviewHandoff.preparedAssetIds[0]})).data.length>0,true);
});
test('failed optional OCR preserves the image handoff, reports its gap and supports explicit retry',async t=>{
 const{service,p}=await imageProject(t);service.readMaterialImage=async()=>{throw new Error('synthetic OCR failure')};let job=await service.workflow({projectId:p.id,action:'start',ocr:true,maxSteps:10});assert.equal(job.tasks[0].status,'rendered_with_ocr_gap');assert.equal(job.failures.length,0);assert.equal(job.ocrFailures.length,1);assert.equal(job.reviewHandoff.preparedAssetIds.length,1);
 const run=await service.getRun({projectId:p.id,runId:job.latestRunId});assert.equal(run.workflow.ocrFailures.length,1);assert.equal(run.workflow.reviewHandoff.modelReviewPerformedByWorkflow,false);
 const asset=job.tasks[0].assetId;service.readMaterialImage=async()=>({id:'synthetic-reading',status:'provisional'});job=await service.workflow({projectId:p.id,action:'retry_failed',maxSteps:10});assert.equal(job.ocrFailures.length,0);assert.equal(job.tasks[0].assetId,asset);assert.equal(job.tasks[0].ocrStatus,'provisional');
});
