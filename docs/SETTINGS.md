# 基础设置（0.10.0 开发版）

设置页面位于 DeepSeek Harness 0.2.2-rc.1 的 **设置 → 论文核对**，通过原生设置服务保存配置。插件不启动网页或 HTTP 服务。设置本身不能证明科学内容已经核验。

## 在哪里设置

在安装并启用插件的 Harness profile 中打开 **设置 → 论文核对**，修改后点击 **保存设置**。页面显示保存结果；“重新读取”会放弃页面中尚未保存的编辑。安装到 CLI profile 的配置与桌面 `desktop` profile 不是同一份；修改后按宿主提示应用或重新加载插件。

| 分组/字段 | 作用 |
|---|---|
| `dataDir` | 项目保存目录；修改不会搬迁旧项目 |
| `allowedRoots` | 允许导入的绝对目录；空列表不允许导入 |
| `defaults.scope` | `all` 全部已导入角色；`si` 仅补充信息 |
| `defaults.checks` | 正文/SI 比较、用量/当量、HRMS、NMR、实验复算、图表引用、程序查重、视觉队列 |
| `defaults.formatting` | 启用小数位模板；分别设置 ¹H、¹³C、J、MS 位数；默认关闭 |
| `defaults.formatting.profileText` | 完整 JSON/YAML 模板；有内容时优先于简易小数位配置，支持有效数字、单位和来源 |
| `defaults.scientific` | 积分、化学位移、频率、收率和用量容差；程序图像阈值及预算 |
| `defaults.hrms` | ppm 和可选 mDa 容差；不设置中性式/离子式解释 |
| `defaults.imageTypeRulesJson` | 按类型自定义图片查重规则，空白保留内置策略，详见 REVIEW-0.7.md |
| `defaults.visual` | 全部/同类型配对、同图内部检查、图片数和每批对数；不取代程序查重预算 |
| `defaults.workflow` | 整篇准备时是否启用辅助 OCR（新项目默认关闭）、每次执行步数；图片审核由多模态模型完成 |
| `defaults.report` | 默认 md/json/csv；Markdown 对照图和逐条证据区块展示开关 |

数值阈值是软件/用户偏好，不自动归为期刊规定。期刊强制要求仍需模板记录已核实来源、原文及日期。高级模板替换整个 profile，不把不同规则列表暗中混合。

## 三层优先级

1. **插件默认值**：只在创建项目时捕获，存入项目文件。
2. **项目设置**：通过 `paper_audit_configure_settings` 保存部分补丁；未提供的字段保留当前值。
3. **单次任务设置**：在 `paper_audit_run`、`paper_audit_workflow(start)`、`paper_audit_visual_review(start)` 中传 `settingsJson`；不修改项目偏好。

`paper_audit_settings` 返回插件当前默认值、项目捕获值、项目实际值和任务预览值。只读返回当前 Harness 模型路由、图片能力声明和 PNG 附件能力；缺少宿主服务时标为不可用。它不会读取或保存 API Key。

任务的 `settingsJson` 使用规范字段（`profile`、`scientific` 等），不是界面快捷字段 `formatting`/`imageTypeRulesJson`。快捷字段会在插件加载时转换并校验。

项目设置示例：

```json
{
  "scope": "si",
  "checks": {"pixelDuplicates": true, "visualReview": true},
  "hrms": {"ppmTolerance": 3, "mDaTolerance": null},
  "workflow": {"ocr": false, "maxSteps": 2},
  "visual": {"mode": "all", "includeSelf": true, "maxAssets": 100, "maxPairs": 500},
  "report": {"format": "md", "includeImages": true, "includeEvidence": true}
}
```

调用 `paper_audit_configure_settings(projectId, settingsJson)` 保存；可直接对 Agent 说：

> 将这个项目设为仅核对 SI，HRMS 告警容差 3 ppm；整篇准备暂不做 OCR，报告保留证据和对照图。先查看有效设置，再按这些设置继续。

临时改动可说：

> 这一次关闭程序图片查重，保留视觉 Agent 复核；不要修改项目的默认设置。

重置用 `paper_audit_configure_settings(projectId, reset=true)`，恢复**项目捕获的默认值**，不是当前全局默认值。重置不能同时传补丁。单独的格式、科学容差和 HRMS 工具继续有效；项目实际值也会反映这些旧入口的修改。

## 运行、续跑与报告

- SI 范围只解析 SI 角色，列出排除的正文/来源文件；检查是否通过只能针对这个范围描述。准备工作流返回 `reviewHandoff`，提示 Agent 继续看原图；OCR 失败保留图像，单独列出文字提取失败。图像准备工具的显式文件选择仍可独立使用，范围设置限制的是自动工作流、核对与视觉队列。
- 禁用检查显示 `disabled`。HRMS 告警关闭但 NMR/实验启用时，可能继续提取 MS 分子式作为依赖输入，报告注明依赖提取，不能宣称 HRMS 已检查。
- NMR 或 HRMS 提取检查关闭时，材料清单判断暂缓，避免把未执行的提取误报为材料缺失。
- 工作流与视觉队列在开始时冻结设置；`resume`/`extend` 保持原设置。修改项目设置后旧任务会变为 `stale`，需要重新开始。`maxSteps` 可作为每次调用的执行预算单独调整；恢复时不能改 OCR 或科学设置。
- 视觉队列仍需准备图片并调用当前视觉 Agent 逐对观察。启用开关不会凭空触发模型请求；预算和同类型过滤会留下未检查范围。格式、容差和预算不改变模型能力。
- 运行保存 `appliedSettings`、修订号及任务补丁；设置变更后导出旧运行会提示旧快照。停用检查造成问题消失时不能据此闭环。
- Markdown 包含有效设置和覆盖详情，展示开关只控制对照图及逐条证据区块，计算摘要/引用可能仍包含科学依据。JSON 始终保留完整快照；CSV 随附同名 `.csv.settings.json` 文件。导出工具返回 `settingsPath`，请与 CSV 一起保存。
- 报告默认格式来自所选运行，而非后来修改的设置；导出时可单次覆盖格式与展示开关。每次导出生成新文件，不覆盖旧报告。

## 旧项目与边界

没有设置快照的旧项目继续使用已保存模板、HRMS/科学参数和 0.8 的其他内置默认值，不继承后来设置的全局默认值。首次修改项目设置时捕获旧状态，之后重置恢复这份状态。已保存论文、旧运行和人工决定保留。

分子式口径、限制试剂、反应计量关系、图像类别确认和结论是否成立仍走原有证据及确认流程。配置表单不新增科学事实，也不会把 OCR、模型观察或零告警解释为验证通过。


## 设置页面接入说明

0.9.0 只提供了 Config 和会话设置工具，没有注册可见侧栏页面；旧说明将两者混淆。0.10.0 新增客户端模块，注册 `settings.section`，并将可编辑字段声明为 volatile。保存先由插件校验路径、模板和阈值，再使用宿主 settings.mutate 携带修订号写入当前 profile。新操作读取更新后的配置，正在执行的操作保持开始时的实例。新项目默认值不覆盖已有项目快照。此页面嵌在 Harness 设置中，不运行独立网页服务。
