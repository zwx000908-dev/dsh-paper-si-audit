import { createHash } from 'node:crypto';
import { parseFormula } from './hrms.js';

const id = (...parts) => 'nmr_' + createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);
const HEADER = /(?:\^?1H|¹H|\^?13C|¹³C)\s*NMR/gi;
const ENTITY = /(?:\b(?:compound|product)\s*[:=]?\s*([0-9]+[a-zA-Z]*|[A-Za-z]+[0-9]+[a-zA-Z]*)\b|(?:^|\n)\s*([0-9]+[a-zA-Z]+)\s*[:：])/gi;
const ANALYTICAL = /^\s*(?:(?:\^?1H|¹H|\^?13C|¹³C|19F|31P)\s*NMR|HRMS|(?:EI|ESI)-MS|MS\b|(?:neutral\s+|molecular\s+)?formula\s*[:=]|分子式\s*[:：])/i;
const cite = (block, start = 0, end = block.text.length) => ({ blockId: block.id, start, end, quote: block.text.slice(start, end) });

// Cross-paragraph association is restricted to explicitly named records followed
// by analytical paragraphs. Unrelated prose, a new heading or document ends it.
function recordsFor(document) {
  const records = []; let current = null;
  for (const block of document.blocks ?? []) {
    if (block.metadata?.evidenceOrigin === 'image_table_ocr') { current = null; continue; }
    const marks = [...block.text.matchAll(ENTITY)];
    if (!marks.length && block.text.length < 300) {
      const heading = /\(([0-9]+[a-zA-Z]+)\)\s*[.:：]?\s*$/.exec(block.text);
      if (heading) marks.push({ index: 0, 1: heading[1] });
    }
    if (marks.length) {
      if (marks[0].index) records.push({ entity: null, pieces: [{ block, start: 0, end: marks[0].index }] });
      marks.forEach((mark, i) => { current = { entity: mark[1] ?? mark[2], pieces: [{ block, start: mark.index, end: marks[i + 1]?.index ?? block.text.length }] }; records.push(current); });
    } else if (current?.entity && ANALYTICAL.test(block.text) && current.pieces.length < 12) current.pieces.push({ block, start: 0, end: block.text.length });
    else { current = null; records.push({ entity: null, pieces: [{ block, start: 0, end: block.text.length }] }); }
  }
  return records;
}

function splitPeaks(text) {
  const result = []; let depth = 0, start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++;
    if (text[i] === ')') depth--;
    if (depth < 0) return null;
    if (!depth && /[,;]/.test(text[i])) { result.push(text.slice(start, i).trim()); start = i + 1; }
  }
  if (depth) return null;
  result.push(text.slice(start).trim().replace(/[.;]\s*$/, ''));
  return result.filter(Boolean);
}
function readSpectrum(text, nucleus) {
  const delta = /(?:δ|\bdelta\b)\s*[:=]?\s*/i.exec(text);
  if (!delta) return { status: 'unsupported', reason: '缺少可识别的 δ 位移列表' };
  const peaks = splitPeaks(text.slice(delta.index + delta[0].length).trim());
  if (!peaks?.length) return { status: 'unsupported', reason: '峰列表为空或括号不完整' };
  let count = 0;
  for (const peak of peaks) {
    const match = /^([+−-]?\d+(?:\.\d+)?)(?:\s*[–—-]\s*([+−-]?\d+(?:\.\d+)?))?\s*(?:\(([^()]*)\))?\s*$/.exec(peak);
    if (!match) return { status: 'unsupported', reason: '峰列表混有无法完整解释的文字、范围或注释' };
    const annotations = match[3] ?? '';
    if (nucleus === '1H') {
      const integrals = [...annotations.matchAll(/(?:^|[,;\s])(\d+(?:\.\d+)?)\s*H\b/g)];
      if (integrals.length !== 1) return { status: 'unsupported', reason: '并非每组峰都有唯一的 nH 积分，未以部分积分代替总氢数' };
      count += Number(integrals[0][1]);
    } else {
      if (match[2]) return { status: 'unsupported', reason: '碳谱范围不能直接解释为碳信号数' };
      // A multiplet is one environment; a stated 2C contributes two atoms.
      const carbon = [...annotations.matchAll(/(?:^|[,;\s])(\d+)\s*C\b/g)];
      if (carbon.length > 1) return { status: 'unsupported', reason: '同一碳信号有多个碳数标注' };
      count += carbon.length ? Number(carbon[0][1]) : 1;
    }
  }
  return { status: 'parsed', count: Number(count.toFixed(6)), peakGroups: peaks.length };
}

export function checkNmr(documents, hrmsRecords = []) {
  const issues = [], records = [];
  for (const document of documents) for (const group of recordsFor(document)) {
    const spectra = [], formulas = [];
    for (const piece of group.pieces) {
      const { block, start, end } = piece, text = block.text.slice(start, end);
      const headers = [...text.matchAll(HEADER)];
      headers.forEach((header, i) => {
        let stop = headers[i + 1]?.index ?? text.length;
        const tail = text.slice(header.index + header[0].length, stop);
        const boundary = /\b(?:HRMS|(?:EI|ESI|APCI)-MS|MS|IR|mp|m\.p\.|(?:neutral\s+|molecular\s+)?formula)\b|分子式/i.exec(tail);
        if (boundary) stop = header.index + header[0].length + boundary.index;
        const nucleus = /1H|¹H/.test(header[0]) ? '1H' : '13C';
        const quotation = cite(block, start + header.index, start + stop);
        spectra.push({ nucleus, ...readSpectrum(quotation.quote, nucleus), citation: quotation });
      });
      for (const match of text.matchAll(/(?:\b(?:neutral\s+(?:molecular\s+)?formula|molecular\s+formula|formula)|分子式)\s*[:=：]\s*([^\s,;]+)/gi)) {
        // Formula labels inside HRMS are handled by the existing ion-basis parser.
        if (/\b(?:HRMS|(?:EI|ESI|APCI)-MS|MS)\b/i.test(text.slice(0, match.index))) continue;
        const raw = match[1].replace(/[.;]$/, '');
        try { const parsed = parseFormula(raw); if (parsed.charge) continue; formulas.push({ formula: parsed.formula, counts: parsed.counts, basis: 'explicit_molecular_formula', citation: cite(block, start + match.index, start + match.index + match[0].length) }); } catch { /* missing formula is reported below */ }
      }
      for (const ms of hrmsRecords.filter(r => r.documentId === document.id && r.blockId === block.id && r.start >= start && r.start < end && r.formula)) {
        for (const candidate of ms.candidates ?? []) {
          const molecule = candidate.basis === 'neutral' ? ms.formula : candidate.adductCompositionCheck?.moleculeFormula;
          if (!molecule) continue;
          try { const parsed = parseFormula(molecule); formulas.push({ formula: parsed.formula, counts: parsed.counts, basis: candidate.basis, ambiguous: ms.status === 'ambiguous', citation: ms.citations.formula }); } catch { /* unsupported formula */ }
        }
      }
    }
    for (const spectrum of spectra) {
      const record = { id: id(document.id, spectrum.citation.blockId, spectrum.citation.start), documentId: document.id, entity: group.entity, ...spectrum, formulas, status: 'insufficient' };
      let reason, title, type = 'coverage';
      const atoms = spectrum.nucleus === '1H' ? 'H' : 'C';
      if (spectrum.status !== 'parsed') reason = spectrum.reason;
      else if (!formulas.length) reason = '当前化合物记录没有可关联的中性分子式；未跨越未知段落或从质荷比猜测分子式。';
      else {
        const expected = [...new Set(formulas.map(f => atoms === 'H' ? (f.counts.H ?? 0) + (f.counts['[1H]'] ?? 0) : Object.entries(f.counts).filter(([key]) => /^(?:C|\[\d+C\])$/.test(key)).reduce((sum, [, count]) => sum + count, 0)))];
        record.expectedCounts = expected;
        const uncertain = formulas.some(f => f.ambiguous) || new Set(formulas.map(f => f.formula)).size > 1;
        const mismatch = spectrum.nucleus === '1H' ? expected.every(n => Math.abs(spectrum.count - n) > 0.05) : expected.every(n => spectrum.count > n);
        record.status = uncertain ? 'ambiguous' : mismatch ? 'needs_review' : 'compatible_count_only';
        if (mismatch || uncertain) {
          type = 'data'; title = uncertain ? '核磁与分子式的对应/离子口径待确认' : spectrum.nucleus === '1H' ? '氢谱报告积分总数与分子式不符' : '碳谱报告信号/标注碳数超过分子式碳数';
          reason = `${spectrum.nucleus} 读取数 ${spectrum.count}；分子式候选 ${atoms} 数 ${expected.join(' / ')}。` + (spectrum.nucleus === '1H' ? '积分不足可能涉及交换氢、漏报、部分积分或混合物；超额可能涉及杂质、归一化或抄录。' : '已将带 J 的多重峰作为一组；仍需检查裂分线、杂质、构象异构体、混合物或抄录。碳信号少于碳数可由对称性或重叠造成，不单独判错。') + '仅比较报告数据，不能证明结构符合或数据造假。';
        }
      }
      if (reason) {
        const citations = [spectrum.citation, ...formulas.map(f => f.citation)].filter((c, i, all) => all.findIndex(x => x.blockId === c.blockId && x.start === c.start && x.end === c.end) === i);
        issues.push({ id: id(record.id, title ?? reason), type, category: 'nmr_formula', severity: type === 'data' ? 'medium' : 'low', evidenceStatus: type === 'data' ? 'needs_review' : 'insufficient', status: 'open', title: title ?? '核磁—分子式核对信息不足', description: reason, evidenceIds: [...new Set(citations.map(c => c.blockId))], citations, calculation: { entity: group.entity, nucleus: spectrum.nucleus, reportedCount: spectrum.count ?? null, expectedCounts: record.expectedCounts ?? [], formulas: formulas.map(f => f.formula) }, nmrRecordId: record.id });
      }
      records.push(record);
    }
  }
  return { issues, records, coverage: { status: records.length ? 'limited' : 'not_performed', recordCount: records.length, comparedRecords: records.filter(r => r.expectedCounts).length, insufficientRecords: records.filter(r => r.status === 'insufficient').length, ambiguousRecords: records.filter(r => r.status === 'ambiguous').length, note: 'Textual 1H integrals and 13C signal/annotated atom counts only. No raw spectrum peak picking, structure prediction, integration normalization or assignment confirmation. 1H equality tolerance: 0.05 H, software setting, not a journal rule. Unassociated paragraphs and image-only spectra remain unchecked.' } };
}
