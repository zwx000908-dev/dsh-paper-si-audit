# DeepSeek Harness 原生接入（0.5.0 开发版）

目标宿主：**DeepSeek Harness 0.2.2-rc.1**。插件开发版本：**0.5.0**。两者分开管理。

本版只有 Harness 原生工具及可选命令行，**没有网页复核面板、本地 HTTP 服务或浏览器入口**。旧运行与旧安装包属于历史产物，不会因移除面板而删除。

## 精确宿主接口

- 上游 tag：`dsh-v0.2.2-rc.1`；commit：`66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`。
- `@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-system-prompt`：`0.2.2-rc.1`。
- `@deepseek-ai/cordis`：`4.1.0`；`@deepseek-ai/schemastery`：`3.19.0`。
- 工具经 `defineTool` / `ctx.tools.register` 注册，配置使用 Schemastery，流程指令通过 `ctx.systemPrompt.section` 注入。
- 原生工具 **38 个**，实际清单由 `createToolDefinitions()` 与集成测试校验。

图像输出使用该版本的真实 `ContentBlock`：`{ type: 'image', attachment: ImageAttachmentRef }`。不能直接把 base64 或路径字符串冒充模型看到了图像。插件在可选 `ctx.attachments` 中保存已登记图像，由当前调用路由的 `llm.resolveModelInfo` 确认其声明支持 image 后再送出 durable image block。文本模型、无附件服务或不受支持的媒体类型会得到明确的 `imageDelivered: false`，本地 OCR 仍可单独使用。

该接口来自本机精确版本的 `dsh-llm`、`dsh-attachment` 和官方 `dsh-tool-fs` 的 `read_image` 实现；并非另建模型代理或调用新的收费端点。图片是否进入远程模型取决于用户选用的 Harness 会话与路由。

参考：

- [精确 tag](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.1)
- [工具规范](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/docs/cookbook/adding-a-tool.zh.md)
- [配置规范](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/docs/user/develop/basic/config.zh.md)
- [打包安装](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/docs/user/develop/basic/publish.zh.md)

## 安装、启用与配置

使用对应桌面版的插件管理或内置 CLI 安装/更新本地 `dsh-paper-si-audit-0.2.0.tgz`，再启用该组合包。无需 GitHub。

需要区分四个状态：包已安装、当前 profile 已选中 bundle、源目录已配置、当前会话已注册工具。已安装不等于已启用；空 `allowedRoots` 会阻止源文件导入，本身不会阻止工具注册。

在插件配置里设置完整绝对路径，例如：

```yaml
- id: paper-si-audit
  name: dsh-paper-si-audit
  config:
    dataDir: 'D:/PaperAudit/projects'
    allowedRoots:
      - 'D:/Research/selected-manuscript'
```

路径只是示例。源目录必须存在；仅授权用户选定目录。profile patch 会替换整份 config，因此应保留需要的全部字段，不覆盖整个用户 profile。

对于独立 CLI profile，可在精确目标 CLI 中使用：

```powershell
dsh --version
dsh plugin --profile paper-audit add ./dsh-paper-si-audit-0.2.0.tgz
```

这管理的是 `paper-audit`，不会自动启用正在运行的 `desktop` profile。普通 npm CLI 对保留 desktop profile 的限制，与桌面内置 CLI 的管理入口不同；不要将独立 profile 安装视为桌面启用证明。详见 [激活诊断](ACTIVATION.md)。

根据宿主反馈重开会话或重启后，确认当前会话可发现下面全部 22 个工具，再进行原生流程验收。

## 原生工具

| 工具 | 用途 |
|---|---|
| `paper_audit_create` | 在授权源目录内创建项目 |
| `paper_audit_projects` | 列出项目 |
| `paper_audit_project` | 读取项目元数据、文档 key 和当前规则 |
| `paper_audit_add_document` | 按 main / si / source 角色导入或替换文档 |
| `paper_audit_profile_validate` | 校验 JSON/YAML 格式模板 |
| `paper_audit_set_profile` | 保存模板，历史运行保留旧快照 |
| `paper_audit_run` | 执行核对并保存新运行 |
| `paper_audit_run_summary` | 查看覆盖、结果摘要与执行入口 |
| `paper_audit_issues` | 分页读取问题 |
| `paper_audit_blocks` | 分页读取原文块 |
| `paper_audit_evidence` | 读取带偏移与定位的原文窗口 |
| `paper_audit_submit_semantic` | 登记带精确原文引用的模型候选 |
| `paper_audit_review` | 记录用户明确的问题复核决定与原因 |
| `paper_audit_export` | 导出 Markdown / JSON / CSV |
| `paper_audit_prepare_visuals` | 从指定 PDF 页或 Office 图片部件准备可追溯图像资产 |
| `paper_audit_visuals` | 分页查看资产与未完成的转换/读取范围 |
| `paper_audit_visual_image` | 按宿主实际能力送出已登记源图，或明确返回未送图 |
| `paper_audit_read_image_table` | 对选定资产或像素裁剪做本地 OCR/表格恢复 |
| `paper_audit_image_tables` | 列出表格；指定 tableId 后分页读取单表全部行及复核状态 |
| `paper_audit_review_image_table` | 记录用户明确的 accepted / rejected / needs_review 决定 |
| `paper_audit_hrms_configure` | 配置本项目分子式口径和 ppm/mDa 提示阈值 |
| `paper_audit_hrms_calculate` | 复算单同位素精确质量与 m/z，保留中性/离子口径歧义 |

长原文按窗口读取，列表每页最多 100 项，运行入口返回摘要，不自动把全文或全部图像塞进每次模型请求。

## 在 Harness 中使用

普通正文/SI 核对可以直接说：

```text
使用 Paper–SI Audit 创建项目，导入我指定的正文和 SI。
先报告解析覆盖，再应用我提供的格式模板并核对。
读取重要候选的原文证据，最后导出报告。
```

图像表格流程：

1. 用项目工具找到源文件的 document key。
2. 明确选择 PDF 页码或 DOCX 图片 part；准备图像资产并查看转换状态。
3. 对实际表格资产调用本地 OCR，必要时用 `crop: { x, y, width, height }` 指定源图像素矩形，宽高不是右下角坐标。
4. 读取带 source hash、行列、单元格文字、像素框和置信/状态信息的结果。`paper_audit_image_tables` 不传 `tableId` 时只列出表格摘要和少量预览行；传 `tableId`、`offset` 和 `limit` 读取该表完整行页，并按 `nextOffset` 继续。默认每页 30 行，最多 100 行；不能把预览当成全表已读。可用视觉模型查看原图，但不可把模型意见当作用户复核。
5. 用户明确核对后才记录表格 accepted；如需更正，传入 `corrections: [{ row: 2, column: 3, text: '0.30' }]`，行列从 1 开始，仅修正用户明确指定的文字，原始 OCR 与来源像素框保留。未复核的 OCR 数字不得冒充已确认的源数据。不能自动把谱图当表格或把读取失败计为通过。

HRMS 可以直接说：

```text
按中性分子式 C2H6O 与离子 [M+H]+ 复算精确 m/z。
论文中写在 calcd for 后的分子式若无法确认是中性式还是离子组成式，
请保留两种解释，不要根据哪个更接近报告数字来选择。
```

可配置的 ppm/mDa 阈值是用户的软件提示设置，不是期刊强制要求。复算使用的同位素质量、电子质量、加合物、电荷和公式口径必须可追溯；详细范围见 [HRMS](HRMS.md)。数学计算不能证明结构或谱图真实性。

## 可选本地 CLI

CLI 不启动网页，`serve` 已移除，会明确拒绝而不创建服务器或项目状态。运行 `node src/cli.js help` 查看 create/add/profile/run/export、visuals/read-table/tables/review-table 及 hrms-config/hrms-calculate。`review-table` 可选 `--corrections JSON`，仅接受用户明确的行/列/文字更正，不接受像素框修改。

这是 Harness 以外的辅助命令入口，运行记录标为 `cli`；不能用 CLI/core API 的成功冒充当前桌面会话原生工具验收通过。

## 验证边界与历史

插件测试使用精确官方 Cordis/Tools/SystemPrompt 包，验证 32 个工具真实注册/卸载、证据分页、图像输入能力 gate、OCR/复核参数以及 HRMS 计算工具。目标发行版测试通过真实工具执行流水线创建项目、导入合成材料、核对、读取证据、计算质量并导出报告；不依赖网页或额外模型 API。

工具测试中的图片路由使用受控附件与能力夹具，不能据此声称已测试用户的真实视觉模型。实际模型调用、OCR 对具体复杂表格的读取准确率以及用户桌面启用，需分别记录。结果以项目 [验证记录](VALIDATION.md) 为准。

最初 0.1.0 开发时桌面观察为 0.2.1-rc.2；随后真实案例诊断时已是 0.2.2-rc.1，但安装的插件 0.1.0 未启用。此处保留历史，不声称当前桌面配置已被本版自动更新。


## 核磁与图片查重

0.4.0 开发版本在 paper_audit_run 中自动检查可关联的核磁报告积分/碳数与分子式。图片先通过 paper_audit_prepare_image_audit 分页准备，再运行核对。对应边界、使用步骤和覆盖字段见 [核磁与图片检查](NMR-AND-IMAGES.md)。


0.5.0 新增六个原生工具：cross_references、revisions、revalidate、experiments、workflow、material_text（均带 paper_audit_ 前缀）。完整参数和执行边界见 [0.5 使用说明](WORKFLOW-0.5.md)。
