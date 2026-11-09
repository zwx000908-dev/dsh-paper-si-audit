const line = value => String(value ?? '').replaceAll('|', '\\|').replace(/[\r\n]/g, ' ');
const shortNumber = value => { if (value === null || value === undefined) return '未核验'; const text = String(value); return text.length > 22 ? text.slice(0, 22) + '…' : text; };
export function summarizeIssues(issues) {
  const byType = {}, bySeverity = {}, byEvidenceStatus = {};
  for (const issue of issues) { byType[issue.type] = (byType[issue.type] ?? 0) + 1; bySeverity[issue.severity] = (bySeverity[issue.severity] ?? 0) + 1; byEvidenceStatus[issue.evidenceStatus] = (byEvidenceStatus[issue.evidenceStatus] ?? 0) + 1; }
  return { total: issues.length, byType, bySeverity, byEvidenceStatus, dataAndSemantic: (byType.data ?? 0) + (byType.semantic ?? 0), formatHints: byType.format ?? 0 };
}
export function renderMarkdown(run, evidenceFrom) {
  const summary = summarizeIssues(run.issues);
  const lines = ['# Paper–SI Audit 核对报告', '', `运行：${run.id}`, `日期：${run.createdAt}`, `插件版本：${run.engineVersion}`, `目标宿主：${run.hostTarget}`, `状态：${run.status}`, `执行入口：${run.execution?.entryPoint ?? 'legacy_unknown'}（入口标签不替代宿主工具调用日志）`, `模板：${line(run.profile.profile?.name)} / ${line(run.profile.profile?.version)}`, '', '在本次材料和已完成检查范围内报告结果；未告警不表示全文正确。', '语义核对：' + run.coverage.semanticStatus + '。精确引用匹配不等于科学判断成立。', '', '## 结果摘要', '', `共 ${summary.total} 条候选：数据 ${summary.byType.data ?? 0}、语义 ${summary.byType.semantic ?? 0}、对应待确认 ${summary.byType.alignment ?? 0}、覆盖 ${summary.byType.coverage ?? 0}、格式 ${summary.formatHints}。`, '格式提示按规则分组列于后文，不计为科学数据错误；完整逐条记录保留在 JSON/CSV 导出及项目台账中。', '', '## 覆盖范围', '', '| 文件 | 角色 | 解析状态 | 单位数 | 警告 |', '|---|---|---|---|---|', ...run.coverage.documents.map(d => `| ${line(d.name)} | ${d.role} | ${d.status} | ${d.parsedUnits}/${d.totalUnits} | ${line((d.warnings ?? []).join('; '))} |`), ''];
  if (run.coverage.unmatchedRuleIds?.length) lines.push(`**未命中任何事实的规则：${run.coverage.unmatchedRuleIds.map(line).join(', ')}。这些规则未完成实际字段检查，不能视为通过。**`, '');
  if (run.coverage.disabledRuleIds?.length) lines.push('停用规则：' + run.coverage.disabledRuleIds.map(line).join(', '), '');
  if (run.profileChangedSinceRun || run.hrmsSettingsChangedSinceRun || run.imageTablesChangedSinceRun || run.sourcesChangedSinceRun) lines.push('**当前项目已发生变更；本报告保留旧运行快照，需重新核对：** ' + [['模板', run.profileChangedSinceRun], ['HRMS 设置', run.hrmsSettingsChangedSinceRun], ['图像转录', run.imageTablesChangedSinceRun], ['已登记来源', run.sourcesChangedSinceRun]].filter(([, changed]) => changed).map(([label]) => label).join('、') + '。', '');
  lines.push('检查覆盖详情：', '', '```json', JSON.stringify(run.coverage, null, 2), '```', '', '## 数据、语义、实验对应与覆盖问题', '');
  for (const issue of run.issues.filter(i => i.type !== 'format')) {
    lines.push(`### ${line(issue.title)}`, '', `${issue.type} / ${issue.severity} / ${issue.evidenceStatus} · ${issue.id}`, '', issue.description, '');
    if (issue.category === 'hrms' && issue.calculation?.candidates) {
      const c = issue.calculation;
      lines.push(`复算：${line(c.formula)}；离子 ${line(c.ion ?? '未指定')}；分子式口径 ${line(c.formulaBasis)}。下表为显示摘要，完整精度及引用保留于 JSON。`, '', '| 公式解释 | 最终离子式 | 理论 m/z | calculated 偏差 ppm | found 偏差 ppm |', '|---|---|---|---|---|');
      for (const candidate of c.candidates) lines.push(`| ${line(candidate.basis)} | ${line(candidate.ionFormula)} | ${shortNumber(candidate.mz)} | ${shortNumber(candidate.calcdError?.ppm)} | ${shortNumber(candidate.foundError?.ppm)} |`);
      lines.push('');
      if (issue.suggestion) lines.push('建议：' + (typeof issue.suggestion === 'string' ? issue.suggestion : JSON.stringify(issue.suggestion)), '');
    } else for (const [label, value] of [['复算', issue.calculation], ['建议', issue.suggestion]]) if (value) lines.push(`${label}：${typeof value === 'string' ? value : JSON.stringify(value)}`, '');
    const used = new Set();
    for (const evidenceId of issue.evidenceIds) {
      try {
        const e = evidenceFrom(run, evidenceId);
        if (used.has(e.block.id)) continue; used.add(e.block.id);
        const citations = issue.citations?.filter(c => c.blockId === e.block.id) ?? [];
        const start = citations.length ? Math.min(...citations.map(c => c.start)) : e.fact?.contextStart ?? e.fact?.offset ?? 0;
        const end = citations.length ? Math.max(...citations.map(c => c.end)) : e.fact?.contextEnd ?? e.fact?.end ?? Math.min(e.block.text.length, 400);
        const left = Math.max(0, start - 100), right = Math.min(e.block.text.length, Math.max(end, start + 80) + 100, left + 1500);
        const quote = `${left ? '…' : ''}${e.block.text.slice(left, right)}${right < e.block.text.length ? '…' : ''}`;
        lines.push(`证据：${line(e.document.name)} · ${line(e.block.locator.label)} · ${evidenceId} · 字符窗口 ${left}–${right}`, '', '> ' + quote.replace(/\r?\n/g, '\n> '), '');
      } catch { lines.push(`证据定位失败：${evidenceId}`, ''); }
    }
    const review = run.reviews.filter(r => r.issueId === issue.id).at(-1);
    if (review) lines.push(`人工记录：${review.status} — ${review.reason}`, '');
  }
  lines.push('## 格式提示分组', '', '以下为选定模板的显示规则提示，不判断期刊要求真实性或测量精度。每组最多显示 5 个示例，未展示条目仍保留在台账及 JSON/CSV 中。', '');
  const groups = new Map();
  for (const issue of run.issues.filter(i => i.type === 'format')) {
    const key = JSON.stringify([issue.ruleId, issue.title, issue.evidenceStatus]);
    const group = groups.get(key) ?? []; group.push(issue); groups.set(key, group);
  }
  if (!groups.size) lines.push('没有格式提示；请结合未命中、停用规则和解析覆盖解读。', '');
  for (const group of groups.values()) {
    const sample = group[0]; lines.push(`### ${line(sample.ruleId ?? '未指定规则')} · ${line(sample.title)}（${group.length} 条）`, '', `证据状态：${sample.evidenceStatus}。`, '', '| 文件与位置 | 原始值 | 显示建议 | 问题 ID |', '|---|---|---|---|');
    for (const issue of group.slice(0, 5)) {
      try { const e = evidenceFrom(run, issue.evidenceIds[0]); lines.push(`| ${line(e.document.name)} · ${line(e.block.locator.label)} | ${line(e.fact?.raw ?? '(见原文)')} | ${line(issue.suggestion ?? '需人工确认')} | ${issue.id} |`); }
      catch { lines.push(`| 定位失败 | | | ${issue.id} |`); }
    }
    if (group.length > 5) lines.push('', `另 ${group.length - 5} 条未在摘要中展开。`);
    lines.push('');
  }
  if (run.changes) lines.push('## 修订复核', '', '```json', JSON.stringify(run.changes, null, 2), '```', '');
  return lines.join('\n');
}
