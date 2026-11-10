import { readFile, mkdir, writeFile, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { evaluatePredictions } from '../src/evaluation.js';
const root=fileURLToPath(new URL('../',import.meta.url));
if(!process.argv[2]||!path.isAbsolute(process.argv[2]))throw new Error('Supply absolute exported report.json after visual review and paper_audit_run');
const input=process.argv[2],mapping=JSON.parse(await readFile(process.argv[3]??path.join(root,'test-output/visual-benchmark/mapping.json'),'utf8'));
const manifest=JSON.parse(await readFile(path.join(root,'benchmarks/biofors-external.json'),'utf8')),baseline=JSON.parse(await readFile(path.join(root,'benchmarks/biofors-baseline-0.7.json'),'utf8'));
if(mapping.manifestHash!==createHash('sha256').update(JSON.stringify(manifest)).digest('hex'))throw new Error('Frozen manifest mapping mismatch');
const files=(await stat(input)).isDirectory()?(await readdir(input)).filter(f=>f.endsWith('.json')).map(f=>path.join(input,f)):[input];
const runs=new Map();
for(const file of files){const r=JSON.parse(await readFile(file,'utf8')),job=mapping.jobs.find(j=>j.projectId===r.projectId&&j.jobId===r.visualReview?.coverage.jobId);if(!job)continue;
 for(const a of manifest.assets.filter(a=>a.path.startsWith(job.paperId+'/')))if(!r.documents.some(d=>d.sha256===a.sha256))throw new Error('Real source missing from run');
 const prior=runs.get(r.projectId);if(!prior||r.createdAt>prior.createdAt)runs.set(r.projectId,r);
}
if(!runs.size)throw new Error('No exported audit reports match the prepared benchmark projects/jobs');
const cases=manifest.cases.map(c=>{
 const linked=mapping.cases.find(x=>x.id===c.id),run=runs.get(linked?.projectId),r=run?.visualReview.records.find(r=>r.taskId===linked.taskId);let observed='abstain';
 if(run&&!['stale','cancelled'].includes(run.visualReview.coverage.status)&&r?.state==='submitted')observed=['suspected_duplicate','possible_legitimate_reuse'].includes(r.record.observation.decision)?'positive':r.record.observation.decision==='no_correspondence'?'negative':'abstain';
 const program=baseline.cases.find(x=>x.id===c.id).observed;
 const combined=program==='positive'||observed==='positive'?'positive':program==='negative'&&observed==='negative'?'negative':'abstain';
 return{id:c.id,paperId:c.paperId,category:c.category,expected:c.expected,observed,program,combined,model:r?.record.actor??null};
});
const result={dataset:manifest.dataset,runIds:[...runs.values()].map(r=>r.id),reportedPapers:runs.size,totalPapers:manifest.paperIds.length,programBaselineVersion:'0.7.0',program:evaluatePredictions(cases.map(c=>({...c,observed:c.program}))),vision:evaluatePredictions(cases),combined:evaluatePredictions(cases.map(c=>({...c,observed:c.combined}))),byCategory:Object.fromEntries([...new Set(cases.map(c=>c.category))].map(k=>[k,evaluatePredictions(cases.filter(c=>c.category===k))])),cases,scope:'Previously inspected development subset; not a fresh blinded evaluation. Saved model observations and attachment receipts do not independently prove model inspection. Missing/uncertain/stale cases abstain. Combined positive if either detects; negative only if both decide negative.'};
const out=path.join(root,'test-output/evaluation/visual-comparison.json');await mkdir(path.dirname(out),{recursive:true});await writeFile(out,JSON.stringify(result,null,2));console.log(JSON.stringify({output:out,program:result.program,vision:result.vision,combined:result.combined},null,2));
