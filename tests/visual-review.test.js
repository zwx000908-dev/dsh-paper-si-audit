import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createHash } from 'node:crypto';
import { AuditService } from '../src/service.js';
import { createToolDefinitions } from '../src/plugin.js';
const actor={provider:'fixture',model:'vision',toolCallId:'synthetic-tool-call'};
const execution={modelSelection:actor,signal:new AbortController().signal,toolCallId:'synthetic-pair-call'};
const picture=(different=false)=>{const c=createCanvas(160,120),x=c.getContext('2d');x.fillStyle='white';x.fillRect(0,0,160,120);x.fillStyle='black';x.fillRect(different?80:10,10,40,60);return c.toBuffer('image/png');};
async function setup(t,n=2){const root=await mkdtemp(path.join(tmpdir(),'visual-agent-'));t.after(()=>rm(root,{recursive:true,force:true}));const config={dataDir:path.join(root,'data'),allowedRoots:[root]},service=await new AuditService(config).init(),p=await service.createProject({name:'Synthetic visual review'});
 for(let i=0;i<n;i++){const file=path.join(root,`image${i}.png`);await writeFile(file,picture(i===1));await service.addDocument({projectId:p.id,filePath:file,role:i?'si':'main'});const d=(await service.getProject(p.id)).documents.at(-1);await service.prepareVisuals({projectId:p.id,documentKey:d.key});}
 return{root,service,p,config};}
function bridge({vision=true,failSecond=false}={}){let calls=0;return{ctx:{get:key=>key==='llm'?{resolveModelInfo:async()=>({inputModalities:vision?['image','text']:['text']})}:key==='attachments'?{imageLimits:{mediaTypes:['image/png']},saveImage:async({data})=>{if(failSecond&&++calls===2)throw new Error('second attachment failed');const im=await loadImage(data);return{attachmentId:createHash('sha256').update(data).digest('hex'),mediaType:'image/png',width:im.width,height:im.height,bytes:data.length};}}:null}};}
const byName=(service,name,b=bridge())=>createToolDefinitions(service,b).find(t=>t.name===name);
const decision=(name='suspected_duplicate')=>({decision:name,basis:'scientific_content',reason:'Synthetic observation fixture, not a real model judgment',checkedFeatures:['Compare content regions rather than shared margins'],limitations:['Synthetic plumbing test only'],typeCandidates:['photograph','photograph'],regions:name==='suspected_duplicate'?[{a:{x:10,y:10,width:40,height:60},b:{x:80,y:10,width:40,height:60},feature:'Known black rectangle fixture',transform:'translation'}]:[]});
async function start(service,p,options={includeSelf:false}){return service.visualReview({projectId:p.id,action:'start',options});}
async function deliver(service,p,job,args={},b=bridge()){return byName(service,'paper_audit_visual_pair',b).execute({projectId:p.id,jobId:job.jobId,...args},execution);}
async function submit(service,p,job,d,result=decision()){return byName(service,'paper_audit_submit_visual').execute({projectId:p.id,jobId:job.jobId,taskId:d.taskId,receiptId:d.receiptId,resultJson:JSON.stringify(result)},execution);}
test('queue is independent of pixel hits and preserves pair budgets, restart, self checks and exclusions',async t=>{
 const{service,p,config}=await setup(t,3),run=await service.runAudit({projectId:p.id});const job=await start(service,p,{maxPairs:1});assert.equal(job.coverage.totalEligiblePairs,6);assert.equal(job.coverage.scheduledPairs,1);assert.equal(job.coverage.remainingPairs,5);
 const other=await new AuditService(config).init();assert.equal((await other.visualReview({projectId:p.id})).jobId,job.jobId);const next=await other.visualReview({projectId:p.id,action:'extend'});assert.equal(next.coverage.scheduledPairs,2);
 const full=await start(service,p,{includeSelf:false});assert.equal(full.coverage.totalEligiblePairs,3);assert.ok(full.coverage.totalEligiblePairs>run.issues.filter(i=>i.category==='image_duplicate').length);
});
test('native pair delivers both attachments with source receipt and maps detail crops to original coordinates',async t=>{
 const{service,p}=await setup(t),job=await start(service,p),tool=byName(service,'paper_audit_visual_pair');
 await assert.rejects(deliver(service,p,job,{cropsJson:JSON.stringify([{x:0,y:0,width:80,height:80},null])}),/full originals/);
 const d=await deliver(service,p,job);assert.equal(d.imageDelivered,true);assert.equal(d.images.length,2);assert.equal(tool.output.render({},d).filter(b=>b.type==='image').length,2);assert.equal(d.images[0].data,undefined);assert.equal(d.images[0].sourceWidth,160);
 const crop=await deliver(service,p,job,{taskId:d.taskId,cropsJson:JSON.stringify([{x:10,y:10,width:40,height:60},{x:80,y:10,width:40,height:60}])});assert.equal(crop.images[1].crop.x,80);assert.equal(crop.attachments[0].width,40);
 const r=await submit(service,p,job,crop);assert.equal(r.geometryValidated,true);assert.equal(r.scientificallyVerified,false);assert.equal(r.evidenceStatus,'needs_review');assert.equal(r.previews.length,1);assert.ok((await readFile(r.previews[0].path)).length>100);
 const repeat=await submit(service,p,job,crop);assert.equal(repeat.idempotent,true);
 const run=await service.runAudit({projectId:p.id});assert.equal(run.coverage.visualAgentReview.modelObservedPairs,1);assert.equal(run.issues.filter(i=>i.category==='visual_duplicate').length,1);assert.ok((await service.exportReport({projectId:p.id,format:'md'})).content.includes('视觉 Agent 图片复核'));
});
test('missing/partial attachment delivery cannot be submitted; failure is durable and retryable',async t=>{
 const{service,p}=await setup(t),job=await start(service,p);
 for(const b of [bridge({vision:false}),bridge({failSecond:true})]){const d=await deliver(service,p,job,{},b);assert.equal(d.imageDelivered,false);const status=await service.visualReview({projectId:p.id});assert.equal(status.counts.failed,1);assert.equal(status.nextAction,'retry_failed');await assert.rejects(submit(service,p,job,{taskId:d.taskId,receiptId:'invented'}),/receipt/);await service.visualReview({projectId:p.id,action:'retry_failed'});}
 assert.equal((await deliver(service,p,job)).imageDelivered,true);
});
test('reject invented receipt, wrong model, axes-only accusation, missing features and out-of-bounds regions',async t=>{
 const{service,p}=await setup(t),job=await start(service,p),d=await deliver(service,p,job);
 await assert.rejects(submit(service,p,job,{...d,receiptId:'invented'}),/receipt/);
 await assert.rejects(service.submitVisualResult({projectId:p.id,jobId:job.jobId,taskId:d.taskId,receiptId:d.receiptId,result:decision()},{provider:'other',model:'vision'}),/same recorded model/);
 await assert.rejects(submit(service,p,job,d,{...decision(),basis:'shared_layout'}),/axes/);
 await assert.rejects(submit(service,p,job,d,{...decision(),regions:[]}),/regions/);
 await assert.rejects(submit(service,p,job,d,{...decision(),regions:[{...decision().regions[0],a:{x:159,y:0,width:40,height:60}}]}),/in-bounds/);
});
test('same-image comparisons require distinct regions and retain uncertainty as review evidence',async t=>{
 const{service,p}=await setup(t,1),job=await start(service,p,{includeSelf:true}),d=await deliver(service,p,job);
 await assert.rejects(submit(service,p,job,d,{...decision(),regions:[{...decision().regions[0],b:decision().regions[0].a}]}),/self-overlap/);
 await submit(service,p,job,d,decision('uncertain'));const run=await service.runAudit({projectId:p.id});assert.equal(run.coverage.visualAgentReview.decisionCounts.uncertain,1);assert.equal(run.issues.find(i=>i.category==='visual_duplicate').type,'coverage');
});
test('new source invalidates receipt, history and active candidates without modifying old run',async t=>{
 const{service,p,root}=await setup(t),job=await start(service,p),d=await deliver(service,p,job);await submit(service,p,job,d);const old=await service.runAudit({projectId:p.id});
 await writeFile(path.join(root,'image0.png'),picture(true));assert.equal((await service.visualReview({projectId:p.id})).status,'stale');await assert.rejects(submit(service,p,job,d),/stale/);
 const latest=await service.runAudit({projectId:p.id});assert.equal(latest.coverage.visualAgentReview.status,'stale');assert.equal(latest.issues.filter(i=>i.category==='visual_duplicate').length,0);assert.equal((await service.getRun({projectId:p.id,runId:old.id})).issues.filter(i=>i.category==='visual_duplicate').length,1);
});
test('no-correspondence is a model observation, never a scientific pass; cancellation cannot resume',async t=>{
 const{service,p}=await setup(t),job=await start(service,p),old=await service.runAudit({projectId:p.id}),d=await deliver(service,p,job);await submit(service,p,job,d,decision('no_correspondence'));
 assert.equal((await service.getRun({projectId:p.id,runId:old.id})).visualReviewsChangedSinceRun,true);const run=await service.runAudit({projectId:p.id});assert.equal(run.coverage.visualAgentReview.scientificallyVerifiedPairs,0);assert.equal(run.visualReview.records.length,1);assert.equal(run.issues.filter(i=>i.category==='visual_duplicate').length,0);
 await service.visualReview({projectId:p.id,action:'cancel'});await assert.rejects(deliver(service,p,job),/cancelled/);
});

test('annotated comparison is readable, corrections retain history and invalidate old delivery receipts',async t=>{
 const{service,p}=await setup(t),job=await start(service,p),d=await deliver(service,p,job),first=await submit(service,p,job,d);
 const tool=byName(service,'paper_audit_visual_comparison'),view=await tool.execute({projectId:p.id,jobId:job.jobId,taskId:d.taskId},execution);assert.equal(view.resultId,first.id);assert.equal(view.imageDelivered,true);assert.equal(tool.output.render({},view).filter(x=>x.type==='image').length,1);
 await service.visualReview({projectId:p.id,action:'reopen',taskId:d.taskId,reason:'Synthetic reviewer finds the correspondence inconclusive'});
 await assert.rejects(submit(service,p,job,d),/receipt/);const pending=await service.runAudit({projectId:p.id});assert.equal(pending.issues.filter(i=>i.category==='visual_duplicate').length,0);assert.equal(pending.coverage.visualAgentReview.uninspectedPairs,1);
 const next=await deliver(service,p,job);await submit(service,p,job,next,decision('uncertain'));const revised=await service.runAudit({projectId:p.id});assert.equal(revised.visualReview.records[0].history.length,1);assert.equal(revised.visualReview.records[0].history[0].id,first.id);assert.equal(revised.coverage.visualAgentReview.decisionCounts.uncertain,1);
});
test('model switch cannot reuse another route full-image view as its own inspection',async t=>{
 const{service,p}=await setup(t),job=await start(service,p),d=await deliver(service,p,job);const alternate={...execution,modelSelection:{provider:'fixture',model:'other-vision'}};
 const crop=await byName(service,'paper_audit_visual_pair').execute({projectId:p.id,jobId:job.jobId,taskId:d.taskId,cropsJson:JSON.stringify([null,{x:80,y:10,width:40,height:60}])},alternate);
 await assert.rejects(byName(service,'paper_audit_submit_visual').execute({projectId:p.id,jobId:job.jobId,taskId:d.taskId,receiptId:crop.receiptId,resultJson:JSON.stringify(decision())},alternate),/Full originals/);
});
test('same-type selection and asset caps disclose omissions; layout-only candidates are not accusations',async t=>{
 const{service,p}=await setup(t,3),images=(await service.listVisuals({projectId:p.id})).assets;
 for(let i=0;i<images.length;i++)await service.setImageType({projectId:p.id,assetId:images[i].id,type:i?'chart':'microscopy',reason:'Synthetic explicit classification'});
 const scoped=await start(service,p,{mode:'same_type',includeSelf:false});assert.equal(scoped.coverage.typeExcluded,2);assert.equal(scoped.coverage.totalEligiblePairs,1);
 const capped=await start(service,p,{maxAssets:1});assert.equal(capped.coverage.excludedAssets.length,2);assert.equal(capped.coverage.totalEligiblePairs,1);
});

test('explicit pairs cover only their declared scope and reject reversed duplicates or omitted assets',async t=>{
 const{service,p}=await setup(t,3),a=(await service.listVisuals({projectId:p.id})).assets.map(a=>a.id);
 const job=await start(service,p,{includeSelf:false,pairs:[[a[0],a[2]]]});assert.equal(job.coverage.scheduledPairs,1);assert.equal(job.coverage.pairScopeExcluded,2);
 await assert.rejects(start(service,p,{pairs:[[a[0],a[2]],[a[2],a[0]]]}),/Duplicate explicit pair/);
 await assert.rejects(start(service,p,{maxAssets:1,pairs:[[a[0],a[2]]]}),/ready selected assets/);
});

test('repeated start resumes pending job instead of hiding work; project lists retained job IDs',async t=>{
 const{service,p}=await setup(t),job=await start(service,p);await deliver(service,p,job);const again=await start(service,p);assert.equal(again.jobId,job.jobId);assert.equal(again.resumedExisting,true);assert.equal(again.counts.delivered,1);assert.ok((await service.getProject(p.id)).visualReviewJobIds.includes(job.jobId));
});
test('different image pairs cannot inherit each others revision identity through a shared title',async()=>{
 const {buildRevisionLedger}=await import('../src/revisions.js');
 const make=(id,assets)=>({id,title:'Visual suspicion',category:'visual_duplicate',type:'data',evidenceIds:[],imageEvidence:assets.map(assetId=>({assetId,sourceSha256:assetId,rasterSha256:assetId}))});
 const old={id:'old',issues:[make('one',['a','b'])],facts:[],documents:[]};old.revisionLedger=buildRevisionLedger(old,null);
 const next={id:'next',issues:[make('two',['c','d'])],facts:[],documents:[]};const ledger=buildRevisionLedger(next,old);assert.equal(ledger.items.length,2);assert.equal(ledger.items.find(i=>i.originIssueId==='one').currentIssueId,null);assert.equal(ledger.items.find(i=>i.originIssueId==='two').state,'new');
});

test('separate visual batches survive restart and appear together in MD, JSON and CSV',async t=>{
 const{service,p,config}=await setup(t,3),a=(await service.listVisuals({projectId:p.id})).assets.map(a=>a.id);
 const first=await start(service,p,{includeSelf:false,pairs:[[a[0],a[1]]]});const d=await deliver(service,p,first);await submit(service,p,first,d);
 const second=await start(service,p,{includeSelf:false,pairs:[[a[1],a[2]]]});
 // No intermediate audit: the previous batch must be discovered from saved jobs.
 const restarted=await new AuditService(config).init();const run=await restarted.runAudit({projectId:p.id});
 assert.equal(run.visualReview.records.length,1);assert.equal(run.visualReview.records[0].jobId,first.jobId);
 assert.equal(run.issues.filter(i=>i.category==='visual_duplicate').length,1);
 assert.equal(run.coverage.visualAgentReview.modelObservedPairs,1);assert.equal(run.coverage.visualAgentReview.uninspectedPairs,1);
 assert.equal(run.coverage.visualAgentReview.jobs.length,2);
 for(const format of ['md','json','csv']){const report=await restarted.exportReport({projectId:p.id,format});assert.ok(report.content.includes('视觉模型提出图片重复疑点'));}
 const next=await deliver(restarted,p,second);await submit(restarted,p,second,next,decision('no_correspondence'));
 const final=await restarted.runAudit({projectId:p.id});assert.equal(final.visualReview.records.length,2);assert.equal(final.coverage.visualAgentReview.modelObservedPairs,2);
 assert.equal(final.issues.filter(i=>i.category==='visual_duplicate').length,1);
});
test('overlapping batches count each pair once and cannot silently erase conflicting suspicions',async t=>{
 const{service,p}=await setup(t),first=await start(service,p),d=await deliver(service,p,first);await submit(service,p,first,d);
 const second=await start(service,p),d2=await deliver(service,p,second);await submit(service,p,second,d2,decision('no_correspondence'));
 const run=await service.runAudit({projectId:p.id}),v=run.coverage.visualAgentReview;
 assert.equal(run.visualReview.records.length,2);assert.equal(v.modelObservedPairs,1);assert.equal(v.conflictingPairs.length,1);
 assert.equal(v.decisionCounts.suspected_duplicate,1);assert.equal(v.status,'completed_with_gaps');assert.equal(run.issues.filter(i=>i.category==='visual_duplicate').length,1);
 await service.visualReview({projectId:p.id,jobId:first.jobId,action:'reopen',taskId:d.taskId,reason:'Synthetic explicit correction'});
 const reopened=await service.runAudit({projectId:p.id});assert.equal(reopened.issues.filter(i=>i.category==='visual_duplicate').length,0);
 assert.equal(reopened.coverage.visualAgentReview.pendingReviewTasks,1);assert.equal(reopened.coverage.visualAgentReview.status,'running');
 assert.equal(reopened.coverage.visualAgentReview.nextJobId,first.jobId);assert.equal(reopened.coverage.visualAgentReview.nextTaskId,d.taskId);
});
test('cancelled and stale batches stay historical while valid observations remain current',async t=>{
 const{service,p,root}=await setup(t),first=await start(service,p),d=await deliver(service,p,first);await submit(service,p,first,d);
 await service.visualReview({projectId:p.id,jobId:first.jobId,action:'cancel'});
 const second=await start(service,p),d2=await deliver(service,p,second);await submit(service,p,second,d2,decision('no_correspondence'));
 const run=await service.runAudit({projectId:p.id});assert.equal(run.visualReview.records.length,1);assert.equal(run.visualReview.historicalRecords.length,1);
 assert.equal(run.issues.filter(i=>i.category==='visual_duplicate').length,0);assert.equal(run.coverage.visualAgentReview.modelObservedPairs,1);
 await writeFile(path.join(root,'image0.png'),picture(true));
 const stale=await service.runAudit({projectId:p.id});assert.equal(stale.visualReview.records.length,0);assert.equal(stale.visualReview.historicalRecords.length,2);
 assert.equal(stale.coverage.visualAgentReview.currentSourceModelObservedPairs,0);assert.equal(stale.issues.filter(i=>i.category==='visual_duplicate').length,0);
});
test('missing retained job files are explicit coverage gaps rather than silently dropped batches',async t=>{
 const{service,p}=await setup(t),first=await start(service,p),d=await deliver(service,p,first);await submit(service,p,first,d);
 const second=await start(service,p),d2=await deliver(service,p,second);await submit(service,p,second,d2,decision('no_correspondence'));
 await rm(path.join(service.dir(p.id),'visual-review',first.jobId+'.json'));
 const run=await service.runAudit({projectId:p.id});assert.equal(run.coverage.visualAgentReview.status,'completed_with_gaps');
 assert.ok(run.coverage.visualAgentReview.jobs.some(j=>j.jobId===first.jobId&&j.status==='missing'));
});
test('report scope does not import observations from differently scoped jobs',async t=>{
 const{service,p}=await setup(t),first=await start(service,p),d=await deliver(service,p,first);await submit(service,p,first,d);
 const run=await service.runAudit({projectId:p.id,settings:{scope:'si'}});
 assert.equal(run.visualReview.records.length,0);assert.equal(run.issues.filter(i=>i.category==='visual_duplicate').length,0);
 assert.equal(run.coverage.visualAgentReview.status,'outside_run_scope');
});
