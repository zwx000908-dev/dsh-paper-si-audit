# 正文交叉核对、修订闭环及整篇任务（0.5.0 基础流程）

0.6.0 对实验叙述、通用方法和复算做了扩展；该部分最新用法见 [EXPERIMENTS-0.6.md](EXPERIMENTS-0.6.md)。

兼容 DeepSeek Harness 0.2.2-rc.1，38 个原生工具，不需要网页。输入原件只读；运行、OCR、人工复核和任务检查点保存到项目数据目录。

## 在 Harness 中使用

可以直接提出以下任务：

> 请用 Paper–SI Audit 核对我指定的正文与 SI。导入后启动整篇工作流，逐次续跑直到没有 nextAction，报告每个失败或未覆盖项目。检查明确图表引用与可读取表格的结论数值，解析实验段落并列出缺少的计算条件。材料修改后再运行，逐条说明旧问题仍存在、疑似修复或无法复核；只有我明确确认的新证据才记录为已关闭。导出 Markdown、JSON 和 CSV。

这是宿主内分批调用流程，不会启动隐藏后台服务。关闭 Harness 后任务不会自行继续；重新进入同一个配置/dataDir，调用 resume 即可恢复。保留工作目录和原件，避免移动项目数据。

## 1. 图表与结论的交叉核对

`paper_audit_run` 自动生成图注目录、引用定位和支持的数值比较。用 `paper_audit_cross_references` 分页查看；`definitions=true` 查看定位到的图注。

- 支持 Table、Figure/Fig.、Scheme、图/表的数字/S 数字编号，识别块首和 PDF 行首图注以及 continued 续图。
- 识别 `Table S1. Optimization.`、独占一行的 `Table S1` 和行首英文标题式图注；`Table S1 shows ...` 仍作为叙述引用。重复编号、分图身份、未定位图注保留信息不足。
- 数值比较目前支持明确引用下的最高产率/ee、指定 entry 或单一化合物值，数据来自紧邻图注的结构化 DOCX/Markdown 表格。测量方法必须相容，NMR 收率与分离收率不直接比较。
- Markdown 管道表格保留原行文本和引用偏移。缺测值、不等式、多个候选、未确认 OCR 或方法不明都不能判为通过。
- 一致只代表已解析范围内相容；未定位不表示作者没有提供。图内柱高/曲线、化学结构、无明确引用的全文结论、跨段落复杂限定语不自动完成判断，可用原有精确引文语义候选流程继续复核。

例如正文写 `The isolated yield reached up to 98% yield (Table S1).`，对应表中最高分离收率 92，则生成带正文和表格引用的待复核差异。如果表列为 NMR yield 或含 n.d.，返回无法直接比较。

## 2. 修订后的问题闭环

修改原件后重新 `paper_audit_run`，用 `paper_audit_revisions` 查看台账。

| 状态 | 含义 |
|---|---|
| new | 新出现的问题 |
| still_present | 旧问题本次仍存在 |
| reopened | 曾经人工关闭，本次再次检出 |
| candidate_resolved | 问题未再检出，能唯一定位到已变更的对应文字，待人工确认 |
| not_reproduced | 未再检出，但不能据此认为发生了修复 |
| needs_revalidation | 对应证据仍有其他待处理问题，或人工要求继续复核 |
| cannot_revalidate | 证据消失/歧义、文件失败、规则改变，或没有支持的文字定位 |
| closed_by_user | 用户明确复核当前证据后关闭 |

按来源身份、问题类型/规则、指标和去数值后的文字形态关联；先保留精确问题 ID，再做唯一关联。纯图片、文字大幅改写或重排歧义可能无法自动关联，不能凭“没找到”关闭。源文件已变更、规则变更或旧运行不能用于关闭。`replaceKey` 替换源文件会保留来源身份。

`paper_audit_revalidate` 参数：`projectId`、最新 `runId`、`trackingId`、`status=fixed|needs_review`、用户原因 `reason`、`citationsJson`。引用格式为 `[{"blockId":"实际ID","start":0,"end":20,"quote":"对应原文"}]`，需覆盖该问题全部已重定位证据，后端逐字校验。模型建议不等于用户决定；原运行文件不被修改，复核事件另存，并在读取/报告中显示。原有 `paper_audit_review` 仍可记录“拟修复，待复查”等决定。

## 3. 真实实验段落解析

`paper_audit_experiments` 分页返回自然段落和原有明确字段记录，均含原句引用、单位转换、计算输入、缺项及歧义。

支持常见局部形式：

- `Reagent (32 mg, 0.20 mmol, MW 160 g/mol)`：质量/物质的量检查。
- `Reagent (100 mM, 2 mL, 0.20 mmol)`：浓度/体积检查。
- `Purification afforded 3a (48 mg, 90% yield)`。
- `The product 3a was obtained in 86% yield (51.3 mg, 0.171 mmol)`。

产物句会保留编号、质量、收率、已报 mmol；进行质量收率复算仍需要同块明确的 limiting reagent、product molar mass、stoichiometric factor。多个候选、纯度、溶液/多步情形保留歧义。没有摩尔质量时可列出质量/mmol 隐含的摩尔质量，但它不是独立验证结果。

**不将 1 equiv 自动当作限制试剂，不从 HRMS m/z 取摩尔质量，不把通用方法 A 的规模或隐含反应计量静默套到所有产物。** 字段不足时可回到原文，由用户/宿主明确输入已确认条件，再用现有计算器复算。当前不支持任意自然语言、跨段落自动条件继承或从结构图自动补齐摩尔质量。

## 4. 整篇材料覆盖与任务恢复

`paper_audit_workflow` 支持：

| action | 用法 |
|---|---|
| start | 对项目全部已导入文档建任务；默认 OCR，`ocr=false` 只准备图像和执行现有检查 |
| resume | 从当前检查点继续；默认每次 3 步，`maxSteps` 可设 1–25 |
| status | 读取状态与进度，不做处理；源文件或规则变化时显示 stale |
| retry_failed | 将失败项目重新排队，保留已完成项目 |
| cancel | 取消任务，保留产物和已完成运行 |

返回 `nextAction=resume` 时继续调用。结束状态为 completed 或 completed_with_gaps，后者需查看 failures、tasks 和 coverage。这表示所选流水线结束，**不等于全文科学内容全部通过**。原件或科学规则改变后，新建任务；旧任务保留。单元完成后落盘；崩溃前正在处理的单元可重做。对确认所属进程已经退出的锁自动恢复，仍存活的进程不抢占。

任务覆盖已导入 PDF 页、DOCX 图片及独立图片的登记、渲染、可选本地 OCR，以及已有的分批图片比较。内容哈希校验、失败隔离、每次比较预算、素材上限继续生效；超限不静默当成完成。DOCX OLE 对象、嵌入结构源、复杂图形语义仍不属于支持的图像读取范围。

`paper_audit_material_text` 分页查看全部 OCR 记录；提供 `readingId` 时分页查看词及像素框。OCR 原始文字和来源哈希被保存，运行中另保存可引用文本块，可通过 blocks/evidence 工具查看和提交语义候选；**不自动变成已确认数值事实或表格**。截图/扫描表格仍用专门的 read_image_table 工具，谱图用 read_spectrum，并保持人工复核。运行的 OCR 引文快照总上限 200 万字符、单图 20 万字符，截断会标记；原词列表仍可分页读取。

CLI 同步支持 `workflow`、`cross-references`、`experiments`、`revisions` 和 `revalidate`，运行 `node src/cli.js help` 查看参数。无需浏览器。

## 验证范围

自动测试含最大值与 entry 比较、方法不同/缺测/未确认 OCR、PDF 续图、自然句与单位换算、修订关闭/重开/拒绝伪引用、跨服务重启续跑、取消/失败重试/规则改变失效。原生宿主探针实际调用新增六个工具，使用合成输入，未调用模型，人工决定仅为测试夹具。

真实材料回放用于暴露解析缺口；无法计算的记录明确列出，不能据此宣传真实论文的总体准确率。
