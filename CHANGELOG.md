# Changelog

## 0.10.2 — Retained visual batches and confirmed settings saves

- Aggregate matching, current visual review jobs across batches and restarts; disclose missing, stale, cancelled and out-of-scope jobs. Count distinct image pairs and retain conflicting observations for review.
- Return the saved native settings view, refresh the shared configuration mirror and retain the acknowledged revision while older refreshes arrive.
- Cover report exports, overlapping batches, corrections, delayed settings refresh and consecutive saves with regression tests. See docs/REVIEW-0.10.2.md for the inspection scope and remaining validation gaps.

## 0.10.1 — Directory editing and recoverable settings

- Preserve newlines and spaces while editing allowed directories; normalize lines only on save. Keep rejected edits available for correction.
- Validate source directories and the output location before persisting settings, without creating folders during validation.
- Keep native settings and tools registered when an old directory becomes unavailable. Report the path error on use and recover after a live configuration correction.
- Add input/save regression checks and exercise invalid-directory startup recovery in the exact Harness smoke test.


## 0.10.0 — Visible native settings and multimodal-first image review

- Register the actual “论文核对” page in the Harness settings sidebar; Config alone did not create a page in 0.9.0. Add native client metadata, editable volatile fields, validated revision-fenced saves and live tool configuration.
- Guide multimodal models to inspect originals, panels and detail crops first. Keep OCR and pixel matching as optional aids; lack of a vision route is not an OCR fallback for image review.
- Disable auxiliary OCR by default for new projects while retaining existing preferences. Preserve rendered images when optional OCR fails and expose a model-review handoff separately from preparation completion.
- Keep 47 native tools and Harness 0.2.2-rc.1 compatibility; stable v0.2.0 remains unchanged.

## 0.9.0 — Native settings and reproducible defaults

- Add grouped Harness configuration for scope, enabled checks, format profiles, numerical tolerances, typed-image screening, visual budgets, OCR and report presentation.
- Capture defaults at project creation; retain legacy projects; support persisted project patches, reset to captured defaults and task-only overrides.
- Freeze effective settings in audit/visual/workflow jobs and reports. Mark excluded/disabled checks explicitly; changed settings invalidate queued work and cannot close disappeared findings.
- Keep model routing and credentials in Harness. Add read-only model capability reporting, CSV settings sidecars and two native tools (47 total).
- Preserve scientific interpretation confirmation and evidence records. This release adds configuration, not measured scientific detection accuracy. Stable v0.2.0 remains unchanged.

## 0.8.0 — Visual-agent review workflow

- Schedule persisted image-pair and within-image review independently of pixel-detector hits, with explicit exclusions, batches, restart, retry and cancellation.
- Deliver paired originals and detail crops through the active Harness vision model route; reject observations without a real receipt or with invalid source coordinates.
- Preserve model type proposals, corresponding features, transformations and uncertainty separately from human decisions; generate viewable annotated comparisons and retain correction history.
- Include model observations and remaining coverage in reports and shared-evidence groups; source changes invalidate old work.
- Add label-withheld multi-paper task preparation and program/vision/combined evaluation scripts. Model accuracy remains unmeasured; simulated positive responses and no-model host tests are not scientific performance evidence.
- Expose 45 tools; keep Harness 0.2.2-rc.1 and stable v0.2.0 unchanged.


## 0.7.0 — Typed image screening and evidence-based review groups

- Separate image policies for nine types; preserve explicit user classifications, per-type overrides, hashes and resumable-batch invalidation.
- Group review by actual shared method source, local formula evidence, template rule or identical image pair; retain exceptions and individual revision closure.
- Add a frozen external BioFors EDD test subset: 10 real papers, 172 pairs, independently authored upstream labels and reproducible hash-checked downloads.
- Publish the disappointing baseline without tuning or dropping failures: TP 0, FP 0, TN 135, FN 14, positive abstentions 8, negative abstentions 15. No claim of reliable natural-image detection.
- Keep the stable v0.2.0 release and Harness 0.2.2-rc.1 target unchanged; development branch exposes 41 native tools.

- Link explicitly referenced general methods with source citations and override/ambiguity handling.
- Add direct mmol yield calculations and standard-composition molar mass from pinned CIAAW atomic weights.
- Link local concentration reference candidates; separate conditional scenarios from explicit-input checks.
- Distinguish missing-in-scope, unlinked and ambiguous fields; refine purity detection.
- Add source-bound explicit user experimental context decisions; invalidate on source changes.

# 0.5.0 (development)

- Add explicit table/figure reference checks and supported quantitative table comparisons.
- Track issue lineage across revisions with evidence relocation, explicit human closure, and reopening.
- Extract local natural experimental prose with unit conversion and explicit missing assumptions.
- Add durable whole-project material preparation/OCR/audit jobs with restart, failure retry and coverage snapshots.
- Keep Harness 0.2.2-rc.1 compatibility and the existing stable v0.2.0 release.

# 0.4.0 (development)

- Add candidate compound dossiers, explicit evidence decisions and configurable material checklists.
- Add registered panels, bounded local image comparisons, annotated evidence and cached continuation across pair batches.
- Add explicit spectrum label/caption comparison, preserved OCR corrections, and declared experimental arithmetic.
- Add scientific tolerance settings, synthetic evaluation and one-paper provisional reference cases; retain coverage and expert-review gaps.

# 0.3.0 (development)

- Add evidence-linked textual NMR/formula count screening.
- Add registered-image exact and transformed-similarity screening, repeated DOCX placements, paged preparation and coverage.
- Preserve the DeepSeek Harness 0.2.2-rc.1 target and the published v0.2.0 release.

# 更新记录

## 0.2.0 — 2026-11-09

兼容目标：DeepSeek Harness **0.2.2-rc.1**；Node.js **24.9.0+**。

- 移除独立网页复核面板、HTTP 服务和网页启动入口，保留 Harness 原生工具与命令行。
- 新增图像表格读取：按 PDF 页、DOCX 图片部件或独立栅格图像选择来源，离线 OCR，保留单元格像素框、原件/栅格哈希和覆盖状态。
- 新增带理由的表格转录校正、接受和拒绝。原始 OCR 及历史运行保持可追溯；未经接受的转录不会产生已确认差异。
- 新增 HRMS/MS 分子式单同位素精确质量复算、加合物/多电荷与电子质量修正、calculated 舍入检查及 found 的 ppm/mDa 比较。
- 保留中性分子式与最终离子组成的口径歧义，不根据与报告数值的接近程度选择解释。缺失或不支持表达明确报告未完成范围。
- 原生工具扩展至22个，新增图像附件能力判断、单表行分页及计算设置/转录变更提示。
- 发布源码与安装包中排除论文、真实报告、机器日志和本地状态，补充固定版本安装、打包校验与复跑说明。

图像识别需人工核实；精确质量复算不确认结构、仪器分辨率或测量真实性。实际验证范围见 [VALIDATION](docs/VALIDATION.md)。

## 0.1.1 — 2026-11-09

- 支持受限读取大型 Office 原件，改进实体/实验语境归因和 EI-MS 数值提取。
- 新增明确同段用量/当量比例候选、格式提示分组、执行入口记录和只读激活诊断。
- 真实案例修复与验证边界见 [历史记录](docs/REPAIR-0.1.1.md)。

## 0.1.0 — 2026-11-09

- 首个可运行 MVP：正文/SI 导入、数值核对、自定义格式规则、精确证据、人工记录和报告导出。
- 当时包含本地网页工作台；该入口已在0.2.0移除。
