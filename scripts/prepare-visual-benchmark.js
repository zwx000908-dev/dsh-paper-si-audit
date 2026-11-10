import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { AuditService } from '../src/service.js';
const root=fileURLToPath(new URL('../',import.meta.url)),manifest=JSON.parse(await readFile(path.join(root,'benchmarks/biofors-external.json'),'utf8'));
const dataDir=process.argv[2]??path.join(homedir(),'.paper-si-audit'),sourceDir=process.argv[3]??path.join(root,'outputs/biofors-source/images');
if(!path.isAbsolute(dataDir)||!path.isAbsolute(sourceDir))throw new Error('Use absolute data and image directories');
const service=await new AuditService({dataDir,allowedRoots:[sourceDir]}).init();
const mapping={manifestHash:createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),jobs:[],cases:[]};
for(const paperId of manifest.paperIds){
 const project=await service.createProject({name:`BioFors paper ${paperId} - external labels withheld from tools`}),assets=new Map(),cases=manifest.cases.filter(c=>c.paperId===paperId);
 for(const a of manifest.assets.filter(a=>a.path.startsWith(paperId+'/'))){
  const file=path.join(sourceDir,a.path),bytes=await readFile(file);if(createHash('sha256').update(bytes).digest('hex')!==a.sha256)throw new Error('Frozen image hash mismatch');
  await service.addDocument({projectId:project.id,filePath:file,role:'source'});
  const p=await service.getProject(project.id),d=p.documents.find(d=>d.filePath===file);
  const prepared=await service.prepareVisuals({projectId:project.id,documentKey:d.key});assets.set(a.path,prepared.assets.find(a=>a.status==='ready').id);
 }
 const pairs=cases.map(c=>c.assets.map(a=>assets.get(a))),job=await service.visualReview({projectId:project.id,action:'start',options:{pairs,includeSelf:false,maxAssets:500,maxPairs:10000}}),tasks=await service.visualReview({projectId:project.id,action:'tasks',limit:100});
 mapping.jobs.push({paperId,projectId:project.id,jobId:job.jobId,pairs:job.coverage.scheduledPairs});
 mapping.cases.push(...cases.map(c=>({id:c.id,paperId,projectId:project.id,jobId:job.jobId,taskId:tasks.items.find(t=>[...t.assetIds].sort().join('|')===c.assets.map(a=>assets.get(a)).sort().join('|')).id})));
}
const out=path.join(root,'test-output/visual-benchmark');await mkdir(out,{recursive:true});await writeFile(path.join(out,'mapping.json'),JSON.stringify(mapping,null,2));
console.log(JSON.stringify({jobs:mapping.jobs,dataDir,allowedRootRequired:sourceDir,mappingFile:path.join(out,'mapping.json'),modelCalls:0,next:'Use the same dataDir and allowedRoots in Harness. Select an image-capable model, open each project, then follow visual_pair/submit_visual/comparison. Labels are absent from project tasks. Do not ask the model to read benchmark files. This previously inspected subset is not a new blind holdout.'},null,2));
