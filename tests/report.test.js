import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, summarizeIssues } from '../src/report.js';
const base = issues => ({ id: 'r', createdAt: '2026-11-09', engineVersion: '0.1.1', hostTarget: '0.2.2-rc.1', status: 'partial', execution: { entryPoint: 'core_api' }, profile: { profile: { name: 'Custom', version: '1.0.0' } }, issues, reviews: [], coverage: { documents: [], unmatchedRuleIds: ['not-matched'], semanticStatus: 'not_run' } });
test('many formatting hints are grouped without losing counts or claiming checks passed', () => {
  const issues = Array.from({ length: 1445 }, (_, i) => ({ id: `i-${i}`, type: 'format', severity: 'low', evidenceStatus: 'needs_review', ruleId: 'h1', title: 'Display differs', description: 'format only', evidenceIds: [`f-${i}`], suggestion: '7.260' }));
  const rendered = renderMarkdown(base(issues), () => ({ document: { name: 'SI' }, block: { id: 'b', locator: { label: 'p1' }, text: 'x'.repeat(10000) }, fact: { raw: '7.26' } }));
  assert.match(rendered, /1445/); assert.match(rendered, /另 1440 条/); assert.match(rendered, /not-matched/); assert.match(rendered, /不能视为通过/); assert.ok(rendered.length < 10000); assert.ok(!rendered.includes('i-1444'));
  assert.equal(summarizeIssues(issues).formatHints, 1445);
});
test('important issues retain exact bounded context and execution route', () => {
  const issue = { id: 'critical-candidate', type: 'data', severity: 'high', evidenceStatus: 'needs_review', title: 'Amount mismatch', description: 'Confirm source amount', evidenceIds: ['f'], calculation: '0.2 × 1.5 = 0.3' };
  const text = 'x'.repeat(2000) + '3 mmol' + 'y'.repeat(2000);
  const rendered = renderMarkdown(base([issue]), () => ({ document: { name: 'SI' }, block: { id: 'b', locator: { label: 'p37' }, text }, fact: { raw: '3', offset: 2000, end: 2001 } }));
  assert.match(rendered, /core_api/); assert.match(rendered, /3 mmol/); assert.match(rendered, /critical-candidate/); assert.match(rendered, /p37/); assert.ok(!rendered.includes('x'.repeat(1000)));
});

test('Markdown presentation toggles hide real preview and evidence independently without deleting findings',()=>{
 const issue={id:'picture',type:'data',severity:'medium',evidenceStatus:'needs_review',title:'Candidate',description:'Review needed',evidenceIds:['f'],previewPath:'C:/fixture.png',imageEvidence:[]};
 const run=base([issue]),evidence=()=>({document:{name:'SI'},block:{id:'b',locator:{label:'p1'},text:'DISTINCT_SOURCE_EVIDENCE'},fact:{raw:'DISTINCT_SOURCE_EVIDENCE',offset:0}});
 const full=renderMarkdown(run,evidence);assert.match(full,/fixture.png/);assert.match(full,/DISTINCT_SOURCE_EVIDENCE/);
 run.exportPresentation={includeImages:false,includeEvidence:false};const compact=renderMarkdown(run,evidence);assert.equal(compact.includes('fixture.png'),false);assert.equal(compact.includes('DISTINCT_SOURCE_EVIDENCE'),false);assert.match(compact,/Candidate/);assert.equal(run.issues[0].evidenceIds.length,1);
 run.exportPresentation.includeEvidence=true;const quotes=renderMarkdown(run,evidence);assert.match(quotes,/DISTINCT_SOURCE_EVIDENCE/);assert.equal(quotes.includes('fixture.png'),false);
});
