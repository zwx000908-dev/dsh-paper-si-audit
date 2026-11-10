const line = value => String(value ?? '').replaceAll('|', '\\|').replace(/[\r\n]/g, ' ');
const shortNumber = value => { if (value === null || value === undefined) return '未核验'; const text = String(value); return text.length > 22 ? text.slice(0, 22) + '…' : text; };
export function summarizeIssues(issues) {
  const byType = {}, bySeverity = {}, byEvidenceStatus = {};
  for (const issue of issues) { byType[issue.type] = (byType[issue.type] ?? 0) + 1; bySeverity[issue.severity] = (bySeverity[issue.severity] ?? 0) + 1; byEvidenceStatus[issue.evidenceStatus] = (byEvidenceStatus[issue.evidenceStatus] ?? 0) + 1; }
  return { total: issues.length, byType, bySeverity, byEvidenceStatus, dataAndSemantic: (byType.data ?? 0) + (byType.semantic ?? 0), formatHints: byType.format ?? 0 };
}
export function renderMarkdown(run, evidenceFrom) {
  const summary = summarizeIssues(run.issues);
  const presentation=run.exportPresentation??run.appliedSettings?.effective.report??{includeImages:true,includeEvidence:true};
  const lines = ['# Paper–SI Audit 核对报告', '', `运行：${run.id}`, `日期：${run.createdAt}`, `插件版本：${run.engineVersion}`, `目标宿主：${run.hostTarget}`, `状态：${run.status}`, `执行入口：${run.execution?.entryPoint ?? 'legacy_unknown'}（入口标签不替代宿主工具调用日志）`, `模板：${line(run.profile.profile?.name)} / ${line(run.profile.profile?.version)}`, '', '在本次材料和已完成检查范围内报告结果；未告警不表示全文正确。', '语义核对：' + run.coverage.semanticStatus + '。精确引用匹配不等于科学判断成立。', '', '## 结果摘要', '', `共 ${summary.total} 条候选：数据 ${summary.byType.data ?? 0}、语义 ${summary.byType.semantic ?? 0}、对应待确认 ${summary.byType.alignment ?? 0}、覆盖 ${summary.byType.coverage ?? 0}、格式 ${summary.formatHints}。`, '格式提示按规则分组列于后文，不计为科学数据错误；完整逐条记录保留在 JSON/CSV 导出及项目台账中。', '', '## 覆盖范围', '', '| 文件 | 角色 | 解析状态 | 单位数 | 警告 |', '|---|---|---|---|---|', ...run.coverage.documents.map(d => `| ${line(d.name)} | ${d.role} | ${d.status} | ${d.parsedUnits}/${d.totalUnits} | ${line((d.warnings ?? []).join('; '))} |`), ''];
  if(run.appliedSettings) lines.push('## 本次实际设置', '', '```json', JSON.stringify(run.appliedSettings,null,2), '```', '', '停用或排除不等于通过；展示开关不删除 JSON 原始证据。', '');
  if(run.settingsChangedSinceRun) lines.push('**项目设置已变更，本报告是旧快照；请重新核对。**','');
  if (run.visualReviewsChangedSinceRun) lines.push('**视觉模型复核记录已更新，本报告为旧快照，请重新运行核对再导出。**', '');
  if (run.visualReview) {
    const v=run.visualReview.coverage;
    lines.push('## 视觉 Agent 图片复核', '', `任务状态：${line(v.status)}；模型已记录观察 ${v.modelObservedPairs??0} 对；排队范围内未检查 ${v.uninspectedPairs??0} 对；科学验证通过数不由模型判定。`, '', '原图附件准备记录不证明模型真的理解图片；区域坐标通过校验也不证明内容重复。未发现对应不是无重复证明。范围外材料与源变化见覆盖详情。', '', '| 图片对任务 | 模型观察 | 模型路由 | 区域数 | 依据 |', '|---|---|---|---|---|');
    for(const r of run.visualReview.records??[]) lines.push(`| ${r.jobId??v.jobId} / ${r.taskId} | ${r.state}: ${r.record.observation.decision} | ${line(r.record.actor.provider)}/${line(r.record.actor.model)} | ${r.record.observation.regions.length} | ${line(r.record.observation.reason)} |`);
    if(v.jobs)lines.push('',`汇总 ${v.jobs.filter(j=>j.included).length} 个有效任务；${v.conflictingPairs?.length??0} 对图片存在不同判断，需复核。未完成或被排除的范围仍按各任务记录。`);
    for(const j of v.jobs??[])lines.push(`- 任务 ${j.jobId}：${j.status}${j.included?'':'（未计入当前观察）'}`);
    if(run.visualReview.historicalRecords?.length)lines.push('',`另有 ${run.visualReview.historicalRecords.length} 条失效或取消任务的历史观察，保留在 JSON historicalRecords 中，不计入当前核验结果。`);
    lines.push('');
  }
  if (run.coverage.unmatchedRuleIds?.length) lines.push(`**未命中任何事实的规则：${run.coverage.unmatchedRuleIds.map(line).join(', ')}。这些规则未完成实际字段检查，不能视为通过。**`, '');
  if (run.coverage.disabledRuleIds?.length) lines.push('停用规则：' + run.coverage.disabledRuleIds.map(line).join(', '), '');
  if (run.scientificSettingsChangedSinceRun) lines.push('**化合物关联、科学检查设置或清单已更改；本报告为旧快照，请重新核对。**', '');
  if (run.compoundRegistry) {
    lines.push('## 化合物材料清单', '', '同号记录为候选关联；已读取不代表结构正确。未定位不等于作者未提供。', '', '| 化合物 | 类型 | 氢谱文字 | 碳谱文字 | HRMS文字 | 氢谱图 | 碳谱图 |', '|---|---|---|---|---|---|---|');
    const labels = { parsed: '已读取', located_unread: '已定位/未完整读取', not_located: '未定位' };
    for (const c of run.compoundRegistry.compounds) lines.push(`| ${line(c.label)} | ${line(c.classification)} | ${['h1_text', 'c13_text', 'hrms_text', 'h1_spectrum', 'c13_spectrum'].map(k => labels[c.materials[k].status]).join(' | ')} |`);
    lines.push('', `清单来源：${line(run.compoundRegistry.requirements?.name ?? '尚未配置要求，仅列示材料状态')}。完整关联及引用见 JSON 或原生 compounds 工具。`, '');
  }
  if (run.profileChangedSinceRun || run.hrmsSettingsChangedSinceRun || run.imageTablesChangedSinceRun || run.sourcesChangedSinceRun) lines.push('**当前项目已发生变更；本报告保留旧运行快照，需重新核对：** ' + [['模板', run.profileChangedSinceRun], ['HRMS 设置', run.hrmsSettingsChangedSinceRun], ['图像转录', run.imageTablesChangedSinceRun], ['已登记来源', run.sourcesChangedSinceRun]].filter(([, changed]) => changed).map(([label]) => label).join('、') + '。', '');
  if (run.reviewGroups) {
    lines.push('## 按共同原因组织复核', '', '分组表示共享证据或复核入口，不认定共同错误，不改变逐条问题数，也不自动关闭问题。', '', '| 分组 | 类型 | 影响问题数 | 局部例外数 | 分组 ID |', '|---|---|---|---|---|');
    for (const g of run.reviewGroups.groups) lines.push(`| ${line(g.title)} | ${g.kind} | ${g.issueCount} | ${g.excludedLocalOverrideRecordIds.length} | ${g.id} |`);
    lines.push('', '使用 paper_audit_review_groups 查看共同证据、成员缺项、排除的局部改动及下一步。未分组问题仍须逐条复核。', '');
  }
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
    if (issue.previewPath && presentation.includeImages) lines.push(`![疑似重复区域对照](<${issue.previewPath.replaceAll('\\', '/')}>)`, '', '红框为实际参与比较的区域；局部检测窗口不等于精确编辑边界。', '');
    for (const image of presentation.includeEvidence?(issue.imageEvidence ?? []):[]) {
      lines.push(`图像证据：${line(image.name)} · ${line(image.locator?.label)} · ${image.assetId}`, '', `来源 SHA256：${image.sourceSha256}；图像 SHA256：${image.rasterSha256}`, '');
      if (image.path) lines.push(`[打开原图](<${image.path.replaceAll('\\', '/')}>)`, '');
      if (image.locations?.length > 1) lines.push('出现位置：' + image.locations.map(l => `XML ¶${l.paragraph} (${l.part})`).join('；'), '');
    }
    for (const evidenceId of presentation.includeEvidence?issue.evidenceIds:[]) {
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
  if (run.crossReferences) lines.push('## 图表与结论交叉核对', '', `定位图注 ${run.crossReferences.coverage.definitions}；引用 ${run.crossReferences.coverage.references}；数值比较 ${run.crossReferences.coverage.checked}；信息不足 ${run.crossReferences.coverage.insufficient}。图中曲线、结构和任意语义结论不属于自动数值核验。`, '');
  if (run.experimentalProseRecords?.length) {
    const records = run.experimentalProseRecords, checked = records.filter(r => r.calculation).length, conditional = records.filter(r => r.status === 'conditional').length;
    const gapLabels = { not_found_in_checked_scope: '已检查原文未找到', not_linked: '程序尚未关联', ambiguous: '存在多个解释' };
    lines.push('## 实验叙述解析与复算', '', `提取 ${records.length} 组检查记录（不等于独立实验数）；明确条件复算 ${checked} 组，条件性复算 ${conditional} 组，无法计算 ${records.filter(r => r.status === 'insufficient').length} 组。条件性结果不代表通过，1 equiv 不自动等于限制试剂，假设 1:1 不等于已证实计量。`, '', '| 记录 | 化合物 | 类型 | 状态 | 计算结果 | 缺项或限制 |', '|---|---|---|---|---|---|');
    for (const r of records) {
      const results = r.calculation ? `${shortNumber(r.calculation.calculated)} ${r.calculation.unit}` : (r.conditionalCalculations ?? []).map(c => `${shortNumber(c.calculation.calculated)} ${c.calculation.unit}`).join(' / ');
      const gaps = [...new Set((r.gaps ?? []).map(g => `${gapLabels[g.type] ?? g.type}: ${g.field ?? g.code}`))].join('; ');
      lines.push(`| ${r.id} | ${line(r.entity ?? '未唯一归属')} | ${r.kind} | ${r.status} | ${line(results || '未计算')} | ${line(gaps)} |`);
    }
    lines.push('', '每种解释的公式、输入、标准原子量来源、通用方法引用和用户确认历史保存在 JSON/原生 experiments 工具中。已检查范围未找到不代表整篇文献中没有。', '');
  }
  if(run.workflow?.reviewHandoff)lines.push('图片准备已交给多模态模型继续审核；OCR 只是辅助文字，准备工作流本身未执行看图判断。辅助 OCR 失败：'+(run.workflow.ocrFailures?.length??0)+'。','');
  if (run.workflow) lines.push('整篇任务：' + run.workflow.jobId + '；已登记任务 ' + run.workflow.tasks.length + '；执行失败 ' + run.workflow.failures.length + '。任务明细及检查点保存在 JSON 和 workflow 工具中。', '');
  if (run.materialReadings?.length) lines.push('## 整篇图像文字读取', '', `已保存 ${run.materialReadings.length} 份 OCR 记录，均保留未确认标记；读取文字不代表完成表格、谱线或结构验证。失败和未覆盖内容见覆盖记录。`, '');
  if (run.revisionLedger) {
    lines.push('## 问题闭环台账', '', '消失不自动关闭。candidate_resolved 为疑似修复，cannot_revalidate 为无法复核，closed_by_user 仅来自用户对新证据的明确复核。', '', '| 跟踪 ID | 原问题 | 当前状态 | 当前问题 ID |', '|---|---|---|---|');
    for (const row of run.revisionLedger.items.filter(r => r.state !== 'new')) lines.push(`| ${row.id} | ${line(row.title)} | ${row.state} | ${row.currentIssueId ?? ''} |`);
    lines.push('', `状态计数：${JSON.stringify(run.revisionLedger.counts)}`, '');
  }
  if (run.changes) lines.push('## 修订复核', '', '```json', JSON.stringify(run.changes, null, 2), '```', '');
  return lines.join('\n');
}
