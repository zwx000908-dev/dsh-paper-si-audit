import { createHash } from 'node:crypto';
const digest = x => createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 24);
const shape = s => String(s ?? '').replace(/[+−-]?(?:\d+(?:\.\d+)?|\.\d+)/g, '#').replace(/\s+/g, ' ').trim();
const sourceKey = d => d.sourceKey ?? `${d.role}:${d.name}`;
function evidence(run, issue) {
  const out = [];
  for (const eid of issue.evidenceIds ?? []) {
    const fact = run.facts.find(f => f.id === eid), bid = fact?.blockId ?? eid;
    for (const doc of run.documents) {
      const block = doc.blocks.find(b => b.id === bid); if (!block) continue;
      out.push({ sourceKey: sourceKey(doc), sha256: doc.sha256, blockId: block.id, text: block.text, shape: shape(block.text), locator: block.locator, field: fact?.field ?? null, entity: fact?.entity ?? null });
    }
  }
  return [...new Map(out.map(e => [e.blockId, e])).values()];
}
function describe(run, issue) {
  const sources = evidence(run, issue);
  const anchor = digest([issue.category ?? issue.type, issue.title, issue.ruleId, sources.map(s => [s.sourceKey, s.shape, s.field, s.entity])]);
  return { anchor, sources };
}
export function buildRevisionLedger(run, previous) {
  const current = run.issues.map(issue => ({ issue, ...describe(run, issue) }));
  const oldRows = previous?.revisionLedger?.items ?? previous?.issues.map(issue => ({ id: 'track_' + digest([previous.id, issue.id]), originRunId: previous.id, originIssueId: issue.id, currentIssueId: issue.id, title: issue.title, ...describe(previous, issue), state: 'open', firstSeen: previous.id, lastSeen: previous.id })) ?? [];
  const items = [], used = new Set();
  const settingsChanged = previous && (previous.profileRevision !== run.profileRevision || previous.hrmsRevision !== run.hrmsRevision || previous.scientificRevision !== run.scientificRevision);
  for (const prior of oldRows) {
    let matches = current.filter(c => c.issue.id === prior.currentIssueId);
    if (!matches.length) matches = current.filter(c => c.anchor === prior.anchor);
    if (matches.length === 1 && !used.has(matches[0].issue.id)) {
      const c = matches[0]; used.add(c.issue.id);
      items.push({ ...prior, ...describe(run, c.issue), currentIssueId: c.issue.id, lastSeen: run.id, state: prior.state === 'closed_by_user' ? 'reopened' : 'still_present', previousState: prior.state, currentCitations: c.issue.citations ?? [], closure: null }); continue;
    }
    const relocated = [], gaps = []; let changed = false;
    for (const s of prior.sources ?? []) {
      const docs = run.documents.filter(d => sourceKey(d) === s.sourceKey);
      if (docs.length !== 1 || docs[0].coverage.status === 'failed') { gaps.push('source_missing_or_failed'); continue; }
      const doc = docs[0], candidates = doc.blocks.filter(b => shape(b.text) === s.shape);
      if (candidates.length !== 1) { gaps.push('evidence_missing_or_ambiguous'); continue; }
      const b = candidates[0]; changed ||= doc.sha256 !== s.sha256;
      relocated.push({ sourceKey: sourceKey(doc), sha256: doc.sha256, blockId: b.id, start: 0, end: b.text.length, quote: b.text });
    }
    if (matches.length > 1) gaps.push('ambiguous_issue_match');
    if (settingsChanged) gaps.push('settings_changed');
    if (!(prior.sources?.length)) gaps.push('no_textual_revalidation_anchor');
    // Any new issue on the relocated evidence prevents automatic resolution candidacy.
    const related = current.filter(c => c.sources.some(s => relocated.some(r => r.blockId === s.blockId)) && c.issue.type !== 'format').map(c => c.issue.id);
    let state = gaps.length ? 'cannot_revalidate' : related.length ? 'needs_revalidation' : changed ? 'candidate_resolved' : 'not_reproduced';
    if (prior.state === 'closed_by_user' && !changed && !gaps.length && !related.length) state = 'closed_by_user';
    const sources = gaps.length ? prior.sources : prior.sources.map(s => { const r = relocated.find(r => r.sourceKey === s.sourceKey && shape(r.quote) === s.shape); return r ? { ...s, sha256: r.sha256, blockId: r.blockId, text: r.quote } : s; });
    items.push({ ...prior, sources, currentIssueId: null, previousState: prior.state, state, currentCitations: relocated, gaps, relatedIssueIds: related, closure: state === 'closed_by_user' ? prior.closure : null });
  }
  for (const c of current) if (!used.has(c.issue.id)) items.push({ id: 'track_' + digest([run.id, c.issue.id]), originRunId: run.id, originIssueId: c.issue.id, currentIssueId: c.issue.id, title: c.issue.title, anchor: c.anchor, sources: c.sources, firstSeen: run.id, lastSeen: run.id, state: 'new', currentCitations: c.issue.citations ?? [] });
  return { items, counts: revisionCounts(items), note: 'Disappearance never closes an issue. Closure requires explicit human revalidation in a new run with exact current citations. Image-only and ambiguous relocation remain unresolved.' };
}
export const revisionCounts = items => items.reduce((o, x) => (o[x.state] = (o[x.state] ?? 0) + 1, o), {});
export function applyRevalidations(ledger, decisions) {
  if (!ledger) return ledger;
  const items = ledger.items.map(row => { const decision = decisions.filter(d => d.trackingId === row.id).at(-1); return decision ? { ...row, state: decision.status === 'fixed' ? 'closed_by_user' : 'needs_revalidation', closure: decision } : row; });
  return { ...ledger, items, counts: revisionCounts(items) };
}
export function validateRevalidation(run, { trackingId, status, reason, citations }) {
  if (!['fixed', 'needs_review'].includes(status) || typeof reason !== 'string' || !reason.trim() || reason.length > 2000) throw new Error('Explicit user status and reason required');
  const row = run.revisionLedger?.items.find(i => i.id === trackingId); if (!row) throw new Error('Unknown tracked issue');
  if (status === 'fixed' && !['candidate_resolved', 'not_reproduced'].includes(row.state)) throw new Error('Issue is present, ambiguous, or not revalidated; closure refused');
  if (!Array.isArray(citations) || !citations.length || citations.length > 20) throw new Error('Current evidence citations required');
  for (const c of citations) {
    const b = run.documents.flatMap(d => d.blocks).find(b => b.id === c.blockId);
    if (!b || !Number.isInteger(c.start) || !Number.isInteger(c.end) || c.start < 0 || c.end <= c.start || c.end > b.text.length || b.text.slice(c.start, c.end) !== c.quote || !row.currentCitations.some(r => r.blockId === c.blockId)) throw new Error('Revalidation quote must exactly match relocated current evidence');
  }
  if (status === 'fixed' && row.currentCitations.some(r => !citations.some(c => c.blockId === r.blockId))) throw new Error('Revalidate every relocated evidence block');
  return { trackingId, status, reason: reason.trim(), citations: structuredClone(citations), runId: run.id, at: new Date().toISOString(), source: 'explicit_user_decision' };
}
