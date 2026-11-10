import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { evaluatePredictions } from '../src/evaluation.js';
test('external baseline accounts for every frozen case, paper, input hash and abstention',async()=>{
 const bytes=await readFile(new URL('../benchmarks/biofors-external.json',import.meta.url)),m=JSON.parse(bytes),r=JSON.parse(await readFile(new URL('../benchmarks/biofors-baseline-0.7.json',import.meta.url)));
 assert.equal(r.manifestSha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(new Set(m.paperIds).size,10);assert.equal(m.cases.length,172);assert.equal(new Set(m.cases.map(c=>c.id)).size,172);
 const assets=new Map(m.assets.map(a=>[a.path,a]));for(const c of m.cases){assert.ok(m.paperIds.includes(c.paperId));assert.equal(c.assets.length,2);for(const a of c.assets){assert.match(assets.get(a).sha256,/^[a-f0-9]{64}$/);assert.ok(a.startsWith(c.paperId+'/'));}if(c.expected==='positive')assert.ok(c.annotationBoxes.length===2);}
 assert.deepEqual(r.cases.map(c=>[c.id,c.expected]),m.cases.map(c=>[c.id,c.expected]));assert.deepEqual(r.metrics,evaluatePredictions(r.cases));assert.equal(r.papersWithAllImagesAvailable,10);
 assert.equal(r.metrics.truePositive,0);assert.equal(r.metrics.falseNegative+r.metrics.positiveAbstentions,22);assert.equal(r.newIndependentExpertReview,false);
});
