import { createHash } from 'node:crypto';
const digest = x => createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 24);
const unique = rows => [...new Map(rows.map(r => [JSON.stringify(r), r])).values()];
/** Group by shared source, never merely by a similar-looking value or compound number. */
export function buildReviewGroups(run) {
  const groups = new Map(), records = run.experimentalProseRecords ?? [];
  const add = (key, data, issueId, record) => {
    const id = 'cause_' + digest(key), g = groups.get(id) ?? { id, ...data, issueIds: [], recordIds: [], members: [], citations: [] };
    if (issueId) g.issueIds.push(issueId);
    if (record) { g.recordIds.push(record.id); g.members.push({ recordId: record.id, entity: record.entity, kind: record.kind, status: record.status, gaps: record.gaps, localOverride: !!record.context?.methodOverridden }); g.citations.push(...record.citations); }
    groups.set(id, g);
  };
  for (const r of records) {
    if (r.status === 'compatible_with_tolerance') continue;
    const c = r.context ?? {}, doc = run.documents.find(d => d.id === r.documentId);
    const methodAffected = c.methodLinked && !c.methodOverridden && (r.missing.some(k => ['limitingAmountMmol', 'stoichiometricFactor'].includes(k)) || r.problems.some(p => p.code === 'method_amount_equivalent_conflict'));
    if (methodAffected) {
      const method = run.experimentalMethods?.find(m => m.documentId === c.methodDocumentId && m.heading.blockId === c.methodHeadingBlockId);
      add(['method', c.methodDocumentId, c.methodSourceSha256, c.methodHeadingBlockId], { kind: 'shared_method_basis', confidence: 'shared_source_dependency', title: `通用方法 ${c.method}：核对计量基准及当量`, source: { documentId: c.methodDocumentId, sha256: c.methodSourceSha256, methodLabel: c.method, headingBlockId: c.methodHeadingBlockId }, commonCitations: method?.pieces ?? [], nextAction: 'Read the common method; correct source contradictions, or use paper_audit_experiment_context scope=method for an explicit user interpretation, then rerun. Product formulas and local overrides remain individual.' }, r.id, r);
    } else {
      const formula = r.gaps.some(g => g.field === 'molarMassGmol' || g.code === 'neutral_or_ion_formula_basis');
      // Per source block: same compound label elsewhere is not identity evidence.
      const blockId = r.citations[0]?.blockId;
      add(['record_basis', doc?.sha256, blockId, formula ? 'formula' : r.id], { kind: formula ? 'local_formula_basis' : 'individual_record', confidence: 'review_candidate', title: formula ? '同一原文区块的中性分子式/摩尔质量口径' : '独立实验条件待复核', source: { documentId: r.documentId, sha256: doc?.sha256, blockId }, commonCitations: [], nextAction: 'Check each chemical identity and source citation. Use record-scoped interpretation; no blanket formula assignment.' }, r.id, r);
    }
  }
  for (const issue of run.issues.filter(i => i.type === 'format')) add(['format', issue.ruleId, issue.title], { kind: 'shared_format_rule', confidence: 'same_rule_not_proven_same_error', title: `格式规则 ${issue.ruleId ?? issue.title}`, commonCitations: [], nextAction: 'Verify the user-defined template before editing individual source values. Formatting is not a scientific error.' }, issue.id);
  for (const issue of run.issues.filter(i => i.category === 'image_duplicate')) {
    const ids = [...new Set((issue.imageEvidence ?? []).map(e => e.assetId))].sort();
    add(['image_pair', ...ids], { kind: 'same_image_pair', confidence: 'same_evidence_pair', title: '同一图像对的重复候选', assetIds: ids, commonCitations: [], nextAction: 'Review type, original locations and legitimate reuse. Different image pairs are not merged transitively.' }, issue.id);
  }
  const items = [...groups.values()].map(g => ({ ...g, issueIds: unique(g.issueIds), recordIds: unique(g.recordIds), citations: unique(g.citations), issueCount: new Set(g.issueIds).size, status: 'needs_review', excludedLocalOverrideRecordIds: g.kind === 'shared_method_basis' ? records.filter(r => r.context?.methodHeadingBlockId === g.source.headingBlockId && r.context?.methodDocumentId === g.source.documentId && r.context?.methodOverridden).map(r => r.id) : [] })).sort((a,b) => b.issueCount-a.issueCount || a.id.localeCompare(b.id));
  const covered = new Set(items.flatMap(g => g.issueIds));
  return { groups: items, groupCount: items.length, groupedIssueCount: covered.size, ungroupedIssueIds: run.issues.filter(i => !covered.has(i.id)).map(i => i.id), note: 'Grouping schedules review; it does not establish root cause, alter issue counts, confirm interpretations or close downstream issues. Rerun and revalidate individual outcomes.' };
}
