import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { checkImageDuplicates } from '../src/image-duplicates.js';
import { validateScientificConfig } from '../src/scientific-config.js';
import { AuditService } from '../src/service.js';
function image(size=128, rotated=false) { const c=createCanvas(size,size),x=c.getContext('2d');x.fillStyle='white';x.fillRect(0,0,size,size);x.scale(size/128,size/128);if(rotated){x.translate(128,0);x.rotate(Math.PI/2);}x.fillStyle='black';x.fillRect(10,20,20,90);x.fillRect(60,10,60,25);return c.toBuffer('image/png'); }
async function pair(type,b=image(256),options={}) { const bytes=[image(),b];return checkImageDuplicates(bytes.map((_,i)=>({id:String(i),status:'ready',imageType:{type}})),a=>bytes[Number(a.id)],options); }
test('diagram/unknown defaults retain exact reuse but suppress layout-only similarity',async()=>{
 for(const type of ['unknown','mixed_page','spectrum','chart','table','reaction_scheme']){assert.equal((await pair(type)).issues.length,0);const r=await pair(type,image());assert.equal(r.issues[0].calculation.kind,'exact_pixels');assert.equal(r.coverage.exactOnlyAssetIds.length,2);}
 assert.equal((await pair('microscopy')).issues[0].calculation.kind,'similar_image');
});
test('blot keeps orientation while microscopy screens rotations; cross-type is exact-only',async()=>{
 assert.equal((await pair('blot',image(128,true))).issues.length,0);assert.equal((await pair('microscopy',image(128,true))).issues.length,1);
 const r=await checkImageDuplicates([{id:'a',status:'ready',imageType:{type:'microscopy'}},{id:'b',status:'ready',imageType:{type:'spectrum'}}],a=>image(a.id==='a'?128:256));assert.equal(r.issues.length,0);
});
test('user type rules validate and disclose override without silently changing defaults',async()=>{
 assert.throws(()=>validateScientificConfig({imageTypeRules:{spectum:{whole:true}}}));assert.throws(()=>validateScientificConfig({imageTypeRules:{spectrum:{imageRmse:NaN}}}));
 const options=validateScientificConfig({imageTypeRules:{spectrum:{whole:true,imageRmse:.03}}});const r=await pair('spectrum',image(256),options);assert.equal(r.issues.length,1);assert.equal(r.issues[0].calculation.imagePolicy.imageRmse,.03);
});
async function setup(t){const root=await mkdtemp(path.join(tmpdir(),'typed-audit-'));t.after(()=>rm(root,{recursive:true,force:true}));const service=await new AuditService({dataDir:path.join(root,'data'),allowedRoots:[root]}).init();const p=await service.createProject({name:'Synthetic shared causes'});return{root,service,p};}
test('image type persists preparation, invalidates pair resume and rejects changed source',async t=>{
 const {root,service,p}=await setup(t),file=path.join(root,'image.png');await writeFile(file,image());await service.addDocument({projectId:p.id,filePath:file,role:'si'});const key=(await service.getProject(p.id)).documents[0].key;
 const first=await service.prepareVisuals({projectId:p.id,documentKey:key}),a=first.assets[0];await service.runAudit({projectId:p.id});
 await service.setImageType({projectId:p.id,assetId:a.id,type:'spectrum',reason:'Synthetic user classification'});await service.prepareVisuals({projectId:p.id,documentKey:key});
 const run=await service.runAudit({projectId:p.id});assert.equal(run.duplicateImageAssets[0].imageType.type,'spectrum');assert.equal(run.coverage.imageDuplicates.resumedFromRunId,null);
 await writeFile(file,image(256));await assert.rejects(service.setImageType({projectId:p.id,assetId:a.id,type:'chart',reason:'fixture'}),/Source changed/);
});
test('shared method groups preserve exceptions, citations and per-record closure after interpretation',async t=>{
 const {root,service,p}=await setup(t),file=path.join(root,'si.txt');await writeFile(file,'General procedure A\nSubstrate (0.20 mmol, 1.0 equiv.) and reagent (0.30 mmol, 1.5 equiv.) were stirred.\nFollowing general procedure A, product 3a was obtained in 80% yield (32 mg, 0.16 mmol).\nFollowing general procedure A, product 3b was obtained in 90% yield (36 mg, 0.18 mmol).\nFollowing general procedure A, modified on gram-scale, product 3c was obtained in 90% yield (36 mg, 0.18 mmol).');await service.addDocument({projectId:p.id,filePath:file,role:'si'});
 const run=await service.runAudit({projectId:p.id}),g=run.reviewGroups.groups.find(g=>g.kind==='shared_method_basis');assert.equal(g.recordIds.length,2);assert.equal(g.excludedLocalOverrideRecordIds.length,1);assert.ok(g.commonCitations.length);assert.ok(g.members.every(m=>m.gaps.length));
 const doc=run.documents[0],b=doc.blocks[1];await service.setExperimentContext({projectId:p.id,runId:run.id,context:{scope:'method',documentId:doc.id,methodLabel:'A',limitingAmountMmol:.2,stoichiometricFactor:1,reason:'Synthetic user interpretation',citations:[{blockId:b.id,start:0,end:b.text.length,quote:b.text}]}});
 const next=await service.runAudit({projectId:p.id});assert.equal(next.experimentalProseRecords.filter(r=>r.kind==='yield'&&r.calculation).length,2);assert.ok(next.experimentalProseRecords.find(r=>r.entity==='3c').status!=='compatible_with_tolerance');assert.ok(next.revisionLedger.items.every(i=>i.state!=='closed_by_user'));assert.equal((await service.getRun({projectId:p.id,runId:run.id})).reviewGroups.groups.find(x=>x.id===g.id).issueCount,2);
});
