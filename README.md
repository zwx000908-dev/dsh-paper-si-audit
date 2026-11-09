# Paper–SI Audit 0.2.0

用于 **DeepSeek Harness 0.2.2-rc.1** 的原生论文正文与 Supplementary Information 数据核对插件。插件与宿主版本分别管理。

## 本版变化

- **移除网页复核面板**：不再包含 web 目录、HTTP 服务或 npm start。复核通过 Harness 原生工具完成，旧 serve 命令明确拒绝。
- **图像表格读取**：选择 PDF 页、DOCX 嵌入图片，或直接导入 PNG/JPEG/TIFF/WebP/BMP；离线 OCR 输出行列、单元格像素框、置信度和原件/栅格哈希。可按行列更正文字，再明确接受或拒绝。
- **HRMS/MS 精确质量复算**：固定同位素质量表、加合物/多电荷及电子质量修正；分别检查 calculated 的显示舍入与 found 的 ppm/mDa 偏差。中性分子式和最终离子式不明确时保留候选解释。
- 保留大 Office 原件、实体语境、用量/当量候选、自定义格式模板、证据与历史运行。

## 在 Harness 使用

安装需要 **DeepSeek Harness 0.2.2-rc.1**；本插件版本为 **0.2.0**。本项目按 Harness 的 bundle 格式发布，复核在 Harness 会话中完成，**无需打开网页面板**。0.2.0 有 22 个 paper_audit_* 原生工具；旧安装不会自动更新。

可从固定版本的 GitHub 源安装到独立 CLI profile：

```powershell
dsh --version
dsh plugin --profile paper-audit add github:zwx000908-dev/paper-si-audit#v0.2.0
```

也可在 [v0.2.0 Release](https://github.com/zwx000908-dev/paper-si-audit/releases/tag/v0.2.0) 下载 `dsh-paper-si-audit-0.2.0.tgz`，核对同页的 SHA256 后安装：

```powershell
dsh plugin --profile paper-audit add ./dsh-paper-si-audit-0.2.0.tgz
```

两种方式都提供可直接加载的 JavaScript，不依赖用户执行本项目的 TypeScript 构建脚本。GitHub 安装可进一步锁定完整 commit SHA；tarball 是安装资产，GitHub 自动生成的 Source code 压缩包是源码快照。

上面的 `paper-audit` 是独立 profile，**不会自动启用桌面端的 desktop profile**。桌面用户应在对应桌面版插件管理中安装/启用 bundle，并配置目录；具体步骤见 [HARNESS](docs/HARNESS.md)。当前仅声明精确宿主版本的兼容性，不代表其他版本已通过验证。

分别确认包安装、bundle 启用、绝对 dataDir / allowedRoots 配置和当前会话工具注册。只读诊断：npm run doctor -- --profile desktop。默认空 allowedRoots 不允许导入论文。

可直接对 Harness 说：

> 使用 Paper–SI Audit 导入指定的正文与 SI，使用我的格式模板核对。先报告解析覆盖。列出可能含表格的页或图片，只对我选定的来源做 OCR；逐格核实，未经我确认不要接受转录。复算有明确分子式的 MS 数据，口径不明就列出候选，不按最接近值猜测。最后导出 Markdown 和 JSON 报告。

工作流：

1. 创建项目，按 main / si / source 导入材料。
2. prepare_visuals 清点并按页码/部件选择渲染；visual_image 返回宿主图像附件。
3. read_image_table 本地 OCR；image_tables 查看转录、位置和状态。
4. 对照原图明确 review_image_table 的状态与理由，可提供逐格文字更正。未经接受的数据可产生线索，不会产生 confirmed_difference。
5. run 重新核对，evidence 读取原文与 OCR 像素位置，export 导出报告。

宿主不支持图像输入/附件时会明确披露未传递图像；OCR 仍可运行，用户应对照原文件。详见 [图像表格范围](docs/IMAGE-TABLES.md)。

## 自定义格式与质量计算

profiles/custom-demo.yaml 是用户偏好演示，**不代表期刊规定**。通过 paper_audit_profile_validate 校验、paper_audit_set_profile 保存 JSON/YAML 模板；paper_audit_project 可读取已存模板。可按字段设置小数位、有效数字、舍入、单位、局部例外和规则来源。¹H 三位、¹³C 四位等均可自定义，原始值不会被覆盖。

期刊强制规则必须带来源、摘录、日期和核实状态；插件不会自行认证期刊要求。显示建议不写回 Word，补零不等于增加测量精度。

hrms_configure 设置 formulaBasis: neutral | ion | ambiguous 和 ppmTolerance / mDaTolerance。默认 ambiguous 与 5 ppm 是软件配置；calculated 按原文位数检查，不套仪器容差。hrms_calculate 可单独复算。详见 [HRMS 来源、约定与边界](docs/HRMS.md)。

## 数据、证据与边界

支持 DOCX、可检索 PDF、TXT/Markdown、CSV、JSON、XLSX 及上述图像。DOCX/XLSX 上限 128 MiB，其他来源 32 MiB；受限 ZIP/XML 不执行 OLE 或宏。源文件只读，结果采用独立 JSON 快照。

当前 OCR 使用离线英文模型；复杂合并格、手写、低清图、结构式和谱图不能据此自动核实。默认只清点 PDF/DOCX 候选，不把所有谱图当作表格，不把选定表格已读解释为全文已读。

HRMS 复算不确认结构、仪器分辨率或测量真实性。EI-MS 保留未知分辨率；未知元素或不支持表达明确披露。found 缺数不从后文借值，也不当作实测偏差已检查。

源文件、规则、HRMS 设置及转录各有版本。原件修改使旧转录失效；人工更正保留原 OCR；历史运行保持快照。

语义判断复用当前 Harness 模型。本插件不另行调用云 OCR/外部模型；进入宿主上下文的片段或图像可能进入宿主模型及日志，取决于宿主配置。

尚未实现原始谱图确证、完整质量平衡、全文图表引用核对、自动 Word 写回及全面后台恢复。没有告警不表示论文全部正确。

## 开发与命令行

Node.js **24.9.0 或以上**，源码目录运行（与精确目标 Harness 的 Node 要求一致）：

```powershell
npm ci
npm test
npm run check
npm run test:harness
npm run pack:verify
node src/cli.js help
```

独立复算不创建网页或项目：

```powershell
node src/cli.js hrms-calculate --formula C6H12O6 --ion "[M+H]+" --basis neutral
```

项目命令用 --data 指定数据目录、--root 指定论文目录，可完成导入、格式模板、OCR、转录复核、核对和导出。

[设计主文档](设计方案.md) · [验证记录](docs/VALIDATION.md) · [发布与安装规范](docs/PUBLISHING.md) · [更新记录](CHANGELOG.md) · [0.1.1 历史修复](docs/REPAIR-0.1.1.md)

