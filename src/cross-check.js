import { createHash } from 'node:crypto';
const digest = x => createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 24);
const REF = /\b(Table|Fig(?:ure)?\.?|Scheme)\s*(S?\d+)([a-z])?\b|([表图])\s*(S?\d+)([a-z])?/gi;
const label = m => `${/table|表/i.test(m[1] ?? m[4]) ? 'Table' : /scheme/i.test(m[1] ?? '') ? 'Scheme' : 'Figure'} ${(m[2] ?? m[5]).toUpperCase()}`;
const citation = (b, start = 0, end = b.text.length) => ({ blockId: b.id, start, end, quote: b.text.slice(start, end) });
const normalize = x => String(x ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
function issue(record, title, description) {
  return { id: 'cross_' + digest([record.kind, record.citations]), category: 'cross_reference', type: record.status === 'insufficient' ? 'coverage' : 'data', severity: record.status === 'insufficient' ? 'low' : 'medium', status: 'open', evidenceStatus: record.status === 'insufficient' ? 'insufficient' : 'needs_review', title, description, evidenceIds: [...new Set(record.citations.map(c => c.blockId))], citations: record.citations, calculation: record };
}
// References are located syntactically; figures without readable data remain unread.
// Table rows must immediately follow a caption and share a parser table/sheet identity.
export function checkCrossReferences(documents, facts = []) {
  const definitions = [], references = [], records = [], issues = [];
  for (const doc of documents) {
    let pending = null, tableKey = null;
    for (const block of doc.blocks ?? []) {
      const matches = [...block.text.matchAll(REF)];
      const captions = matches.filter(m => {
        const atStart = /^\s*(?:#{1,6}\s*)?$/.test(block.text.slice(block.text.lastIndexOf('\n', m.index) + 1, m.index));
        const tail = block.text.slice(m.index + m[0].length).split('\n')[0];
        return atStart && (/^\s*[.:：]/.test(tail) || !tail.trim() || /^\s+[A-Z][a-zA-Z]+\s/.test(tail) && !/^\s*(?:shows?|gives?|lists?|summarizes?|presents?|indicates?|was|is|see|demonstrates?)\b/i.test(tail));
      });
      if (captions.length) {
        for (const m of captions) {
          const end = block.text.indexOf('\n', m.index), quote = citation(block, m.index, end < 0 ? block.text.length : end);
          const prior = definitions.find(d => d.documentId === doc.id && d.label === label(m));
          if (/^\s*[.:：]\s*(?:continued|续)/i.test(block.text.slice(m.index + m[0].length)) && prior) { (prior.continuations ??= []).push(quote); pending = prior; continue; }
          pending = { id: 'target_' + digest([doc.id, block.id, m.index]), label: label(m), documentId: doc.id, role: doc.role, caption: quote, rowIds: [], panel: m[3] ?? m[6] ?? null };
          definitions.push(pending);
        }
        tableKey = null;
      } else if (block.metadata?.cells && pending?.label.startsWith('Table')) {
        const key = String(block.locator?.table ?? block.locator?.sheet ?? 'contiguous');
        if (tableKey === null) tableKey = key;
        if (tableKey === key) pending.rowIds.push(block.id); else pending = null;
      } else if (block.text.trim()) pending = null;
      for (const m of matches) if (!captions.includes(m)) references.push({ label: label(m), panel: m[3] ?? m[6] ?? null, documentId: doc.id, role: doc.role, block, citation: citation(block, m.index, m.index + m[0].length) });
    }
  }
  for (const ref of references) {
    const candidates = definitions.filter(d => d.label === ref.label);
    const local = candidates.filter(d => d.documentId === ref.documentId);
    const targets = local.length ? local : candidates.filter(d => d.role === (/ S\d+$/.test(ref.label) ? 'si' : ref.role));
    const record = { id: 'reference_' + digest(ref.citation), kind: 'reference', label: ref.label, status: targets.length === 1 ? 'located' : 'insufficient', reason: targets.length ? 'ambiguous_target' : 'target_not_located', citations: [ref.citation, ...targets.map(t => t.caption)], targetIds: targets.map(t => t.id) };
    if (ref.panel) { record.status = 'insufficient'; record.reason = 'panel_identity_not_verified'; }
    records.push(record);
    if (record.status === 'insufficient') { issues.push(issue(record, '图表引用未能唯一定位', '未定位不等于文档中不存在；检查扫描页、图注、分图编号和解析覆盖。')); continue; }
    const target = targets[0], blockFacts = facts.filter(f => f.blockId === ref.block.id && ['yield.percent', 'ee', 'ee.percent'].includes(f.field));
    // Restrict claims to the sentence containing the reference, not other page sentences.
    for (const fact of blockFacts) {
      const from = Math.min(fact.offset, ref.citation.start), to = Math.max(fact.end, ref.citation.end);
      if (/[.!?。](?:\s|$)/.test(ref.block.text.slice(from, to))) continue;
      const sentenceStart = Math.max(ref.block.text.lastIndexOf('\n', from), [...ref.block.text.slice(0, from).matchAll(/[.!?。](?:\s|$)/g)].at(-1)?.index ?? -1) + 1;
      const prefix = ref.block.text.slice(sentenceStart, fact.offset);
      const max = /(?:up to|maximum|maximal|highest|高达|最高|最大)\s*(?:\w+\s+){0,3}$/i.test(prefix);
      const tailEnd = /[.!?。](?:\s|$)/.exec(ref.block.text.slice(to));
      const sentenceEnd = tailEnd ? to + tailEnd.index + 1 : ref.block.text.length;
      const entry = /\bentry\s+(\d+)\b/i.exec(ref.block.text.slice(sentenceStart, sentenceEnd));
      if (!max && !entry && !fact.entity) continue;
      const rows = target.rowIds.map(id => documents.flatMap(d => d.blocks).find(b => b.id === id));
      const selectedRows = entry ? rows.filter(b => b.metadata.cells.some(c => /^(entry|序号)$/i.test(c.header.trim()) && c.text.trim() === entry[1])) : rows;
      let values = facts.filter(f => selectedRows.some(b => b.id === f.blockId) && f.field === fact.field && !f.identityAmbiguous && (max || entry || normalize(f.entity) === normalize(fact.entity)));
      const unavailableBasis = fact.field === 'yield.percent' && (!fact.method || values.some(f => !f.method));
      const incompatibleBasis = fact.field === 'yield.percent' && values.some(f => f.method && fact.method && f.method !== fact.method);
      const gap = !values.length || unavailableBasis || incompatibleBasis || values.some(f => f.comparator !== '=' || f.unverifiedVisual) || fact.comparator !== '=' || fact.unverifiedVisual || (max && (values.length !== rows.filter(b => !b.metadata.headerRow).length || !rows.length)) || (!max && values.length !== 1);
      const citations = [citation(ref.block, sentenceStart, to), target.caption, ...values.map(f => citation(selectedRows.find(b => b.id === f.blockId), f.offset, f.end))];
      const check = { id: 'claim_' + digest([fact.id, target.id]), kind: max ? 'maximum' : 'value', label: ref.label, entity: fact.entity ?? null, field: fact.field, method: fact.method ?? null, status: 'insufficient', citations, claim: fact.value, observed: values.map(f => f.value), reason: gap ? 'unread_or_ambiguous_scope_or_method' : null };
      if (!gap) { const actual = max ? Math.max(...values.map(f => Number(f.value))) : Number(values[0].value); check.actual = actual; check.status = Math.abs(Number(fact.value) - actual) > 1e-9 ? 'needs_review' : 'consistent_in_parsed_scope'; }
      records.push(check);
      if (check.status !== 'consistent_in_parsed_scope') issues.push(issue(check, check.status === 'insufficient' ? '图表与结论尚不能直接比较' : '图表数据与所引结论不一致', '仅比较明确引用及可解析表格中的同一指标/测量方法；最高值比较不涵盖未读图像、脚注排除条件或未指定子集。请核实比较范围。'));
    }
  }
  return { definitions, records, issues, coverage: { definitions: definitions.length, references: references.length, claims: records.filter(r => r.kind !== 'reference').length, checked: records.filter(r => ['consistent_in_parsed_scope', 'needs_review'].includes(r.status)).length, insufficient: records.filter(r => r.status === 'insufficient').length, scope: 'Explicit table/figure/scheme references; quantitative checks use contiguous structured table rows only. Figure plotted values and unrestricted semantic conclusions are not automatically read.' } };
}
