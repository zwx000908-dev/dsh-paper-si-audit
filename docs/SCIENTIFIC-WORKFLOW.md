# 科学材料核对流程（0.4.0 基础流程）

0.6.0 实验解析和关联已扩展，最新说明以 [EXPERIMENTS-0.6.md](EXPERIMENTS-0.6.md) 为准。

本流程全部使用 DeepSeek Harness 0.2.2-rc.1 原生工具，不需要网页。自动候选、人工决定和原始证据分别保存；原文件只读。格式模板继续使用原有 JSON/YAML 配置，本页的材料清单和科学阈值独立配置。

## 1. 化合物档案及材料清单

导入文件后运行 `paper_audit_run`，使用 `paper_audit_compounds` 分页读取档案；`records=true` 返回原文记录 ID、来源哈希和精确引用。相同编号的记录先归入候选档案，不代表已经证明属于相同结构或实验。

材料状态为 `not_located`（未定位）、`located_unread`（已找到标记或图片，尚未完整读取）、`parsed`（已读取支持的字段）。这些状态都不代表科学结果已通过。未知段落和含糊归属保留在覆盖范围中。EI-MS 可列为 `ms_text`，不会冒充 `hrms_text`。

用户可以明确确认材料归属和化合物类别，调用 `paper_audit_set_compound`，其中 `decisionJson` 示例：

```json
{
  "compoundLabel": "3a",
  "classification": "new",
  "links": [
    { "recordId": "实际原文记录ID" },
    { "assetId": "实际图片ID", "kind": "h1_spectrum" }
  ],
  "reason": "用户确认这段表征文字及该氢谱对应化合物3a"
}
```

类别支持 `unknown`、`new`、`known`、`key_intermediate`。对同一标签再次提交会替换当前链接列表，旧决定仍保留。修改后的原件使旧链接失效时，报告会标出；多个标签冲突地占用同一证据时不强行归属。

调用 `paper_audit_set_requirements` 保存清单。以下只是用户定义示例，**不是某期刊的官方要求**：

```json
{
  "name": "课题组表征清单",
  "version": "1.0.0",
  "source_type": "user_defined",
  "rules": [
    {
      "classification": "new",
      "allOf": ["h1_text", "c13_text", "h1_spectrum", "c13_spectrum"],
      "anyOf": [["hrms_text", "elemental_analysis"]]
    },
    { "classification": "known", "allOf": ["reference", "h1_spectrum"] }
  ]
}
```

支持材料种类：`procedure`、`formula`、`h1_text`、`c13_text`、`hrms_text`、`ms_text`、`elemental_analysis`、`h1_spectrum`、`c13_spectrum`、`chromatogram`、`structure`、`reference`。`allOf` 为逐项要求，`anyOf` 内的每个数组表示一组备选条件。未配置清单时只展示状态，不发明强制要求。声明 `official_requirement` 时必须提供 `source.status=verified`、`url`、`quote` 和 `checked_at`，配置校验不能替代对要求本身的人工核实。

## 2. 图像面板及局部重复

对每个图片/DOCX/PDF 来源调用 `paper_audit_prepare_image_audit`，跟进 `nextOffset`，每批最多 10 个素材。PDF 页仍是整页，DOCX 来源仍保留媒体部件和 XML 位置。

使用 `paper_audit_extract_panels` 把整页/整图转成登记面板。可以提供 `rectanglesJson`：

```json
[{ "x": 100, "y": 200, "width": 600, "height": 400 }]
```

坐标是原图像素，宽高至少 16，最多 16 个区域。省略区域时按明显空白间隔产生候选面板；轴线、图注和图内空白可能导致错分，请复核。面板保留父图片 ID 与裁剪坐标，不允许无限嵌套裁剪。

再次运行 `paper_audit_run`，同时检查完整像素、整图缩放/直角旋转/镜像相似，以及多尺度网格窗口的局部相似和图内不重叠区域复用。局部候选的对照 PNG 用红框显示实际比较窗口；它不是像素级编辑边界。前 30 个候选尝试生成对照图，未生成数量和失败原因分别保留。源文件与原始登记图片不会被画框覆盖。

局部搜索目前采用有界网格窗口，不能覆盖任意裁剪比例、任意角度旋转、透视变化或重度编辑；内容相似的图表/谱图可能误报。自己提取的面板和其直接父图片不会被当成重复问题；其他相同图片是否属于合理复用仍需读图注。

默认最多处理 1000 个登记素材、每次比较 2000 对。`coverage.imageDuplicates.nextPairOffset` 非空时，再次调用 `paper_audit_run` 即可在同一项目继续；累计候选、已比较对数和前一运行 ID 保留，不需要拆分项目。内容或科学设置改变时重新开始比较。特征按内容缓存，每次使用前仍核验图像哈希。素材上限可配置到 5000，超限会明确报告，默认不会静默检查无限资源。

## 3. 核磁文字、谱图及实验数字

### 核磁与谱图

报告文字中的 ¹H 积分、¹³C 信号/标注碳数会自动与可关联分子式比较。MS 中性式/离子式不明确时保留候选，不以接近的质量或积分选择解释。碳数少于分子式不单独判错。支持 Chloroform-d/CDCl3 别名，后接 ¹⁹F 等谱段不会混入碳谱计数。

调用 `paper_audit_read_spectrum`，提供一个原文 `recordId` 和谱图 `assetId`，可选 `cropJson`。本地 OCR 读取明确的核种、MHz、溶剂、化合物编号、`Integral sum: …` 以及显式 δ 峰列表；裸露的坐标轴数字、软件积分标记不会自动解释为某个峰的积分。谱图 OCR 不擦除网格或谱线。

如果 DOCX 中图像前的谱图标题能唯一对应到当前原文块，会独立引用该标题。每个观测字段记录 `local_image_ocr` 或 `document_caption`；标题中的 400 MHz 不会被称为图片 OCR 读到的 400 MHz。两者冲突时保留冲突。通过 `paper_audit_spectra` 查看观测与词级像素框，再次运行核对即可与绑定的文字记录比较。

`paper_audit_review_spectrum` 仅记录用户明确的 `accepted/rejected/needs_review` 决定。可用 `fieldsJson` 完整替换观测字段，保留最初 OCR、原始字段、来源和修改历史。允许字段为 `nucleus`、`frequencyMHz`、`solvent`、`compoundLabel`、`integralSum`、`peaks: [{shift,integral}]`。自动识别或模型解释不能冒充人工接受。

本功能尚不自动处理 FID、相位/基线校正、原始谱线拾峰、定量积分或结构确证。没有读到的字段进入 `unchecked`；零观测不能被标成相容。

### 实验复算

自动核对支持同一记录中明确标注的字段，例如：

```text
Compound 3a: limiting_amount: 0.20 mmol; product_mass: 48 mg;
molar_mass: 300 g/mol; stoichiometric_factor: 1; isolated_yield: 90%.
```

复算得到 80%，与报告的 90% 比较。`stoichiometric_factor` 指每摩尔限制试剂理论产生的产物摩尔数，必须明确指定。一般叙述中隐含的限制试剂、纯度、反应计量和跨段落通用步骤不会被猜测补齐。

普通实验叙述可先由 Harness 读取并引用来源，再用 `paper_audit_calculate_experiment` 复算。这个独立计算器本身不验证输入归属；需将计算结果与原文证据一起报告。输入例子：

```json
{"kind":"yield","limitingAmountMmol":0.20,"productMassMg":48,"molarMassGmol":300,"stoichiometricFactor":1,"reportedYieldPercent":90}
```

其他计算：`kind=mass_amount` 使用 `massMg, amountMmol, molarMassGmol`；`kind=concentration` 使用 `concentrationM, volumeMl, amountMmol`。不会用 HRMS 单同位素 m/z 替代称量所用的摩尔质量。

## 自定义科学设置

使用 `paper_audit_scientific_configure` 保存 `optionsJson`。未写的键重置为默认值，历史运行保留之前的设置。以下全部是软件/用户设置，不自动代表期刊或仪器要求：

| 键 | 默认值 | 意义 |
|---|---:|---|
| nmrIntegralTolerance | 0.05 | 氢积分比较容差，H |
| nmrShiftTolerance | 0.03 | 已标注峰之间的对应容差，ppm |
| frequencyToleranceMHz | 1 | 报告频率比较容差，MHz |
| yieldTolerancePercent | 1 | 收率绝对差，百分点 |
| amountRelativeTolerance | 0.02 | 质量/物质的量相对容差 |
| imageRmse | 0.10 | 整图归一化差异阈值 |
| localImageRmse | 0.08 | 局部网格差异阈值 |
| maxImageAssets | 1000 | 最大素材数，最高 5000 |
| imagePairBudget | 2000 | 每次比较对数，最高 100000 |
| localImages | true | 是否执行局部网格与图内比较 |

## 4. 验证与结果解释

`npm test` 验证功能和边界，`npm run test:harness` 验证指定宿主原生调用，`npm run evaluate` 运行合成正负例评估。真实原件回放与参考标签评估的命令、标签来源和限制见 [benchmarks/README.md](../benchmarks/README.md)。

参考依据：[ACS Research Data Guidelines](https://researcher-resources.acs.org/publish/data_guidelines)、[Nature 图像完整性政策](https://www.nature.com/nature/editorial-policies/image-integrity)。项目不根据期刊名字自动推定具体规则。
