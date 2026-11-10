# 实验信息关联与复算（0.6.0 开发版）

兼容 DeepSeek Harness 0.2.2-rc.1。保持原件只读，新增能力通过原生工具和 Markdown/JSON/CSV 报告使用，不需要网页。

## 1. 通用方法继承

识别独立的 `General procedure A` / `General method A` 标题及其后有限范围内的操作段落，再识别产物中的 `Following/According to/Using ... general procedure A`。保留方法标题、操作段落与引用句的精确引用。

优先同一文件内的唯一方法，找不到时才查项目其他文件；重复标签或多处引用不强行选择。明确限制试剂用量和产物计量系数可继承，产物摩尔质量不从通用方法继承。当前段明确的数值优先；局部试剂用量、modified/except/doubled/scale-up 等修改信息会阻止静默继承原规模。复杂修改仍需人工解释。

仅出现 `1.0 equiv` 时，保存为基准候选，不直接认定限制试剂。通用方法中的 mmol/equiv 自相矛盾时，保留冲突；不能因为某个收率恰好吻合就消除冲突。

## 2. 两条收率计算路径

- 原文给出产物 mmol：`100 × productAmountMmol / (limitingAmountMmol × stoichiometricFactor)`，不需要摩尔质量。
- 只给产物质量：先用独立摩尔质量换算，再求收率。不会用质量÷已报告 mmol 得出的隐含摩尔质量去“独立验证”同一组质量/mmol。

示例：产物 0.171 mmol、基准 0.20 mmol、产物计量系数 1，计算为 85.5%，与报告 86% 在默认 1 个百分点容差内相容。是否属于已确认复算，取决于基准和计量依据。

`paper_audit_calculate_experiment` 的 `inputJson` 支持：

```json
{"kind":"molar_yield","productAmountMmol":0.171,"limitingAmountMmol":0.20,"stoichiometricFactor":1,"reportedYieldPercent":86}
```

原有 `yield`、`mass_amount`、`concentration` 保留。`molar_yield` 不要求提供 `molarMassGmol`，零产物允许参与计算。

## 3. 同段浓度与试剂关联

仍优先同一括号中明确给出的浓度、体积、物质的量。若同段明确说明浓度相对于限制试剂，并有唯一的明确限制试剂用量，可关联复算。

只有一个 1-equiv 用量时，可以给出“浓度以该试剂为基准”的条件性计算，但不当成已确认基准。多个 1-equiv 候选、页面中多个实验、未明确的总溶液体积或溶剂组成保留歧义。`pure product`、普通 `mixture of` 不再单独触发纯度错误；数值纯度、粗产物、分取、分析收率及多步等相关局部描述仍保留限制。

## 4. 分子式与摩尔质量

支持同一产物记录中的明确中性/分子式声明，以及单个试剂括号内的分子式。仅有名称或结构图片时不会猜分子式；可由用户核实结构后确认对应中性式。

使用固定版本 [CIAAW 2024 简化标准原子量](https://ciaaw.org/abridged-atomic-weights.htm) 的常见元素子集，输出数据版本、核实日期及公式。使用的是正常同位素组成材料的近似摩尔质量，不是 HRMS 单同位素质量或 m/z。显式盐/水合物按完整提供的式子计算；不自动补反离子、水合物或纯度。带净电荷的式子、富集同位素和未支持元素会拒绝计算。

对于已解析的 MS 分子式/离子形式，只有明确口径时才能用于直接复算；口径不明确时分别列出中性式与离子式反推得到的中性组成候选，**不选择最接近报告值的解释**。图像结构识别、自动化学名称查库以及任意 SMILES/MOL 导入不属于本版新增功能。

独立计算：

```json
{"kind":"molar_mass","neutralFormula":"C2H6O"}
```

得到 46.069 g/mol，并返回来源与数据版本。

## 5. 结果分类与用户确认

每条记录分开保存原始提取字段、计算输入、字段来源、引用、假设和限制。

| 类型 | 含义 |
|---|---|
| compatible_with_tolerance / needs_review | 使用明确输入完成算术比较；仍不证明实验真实性或结构正确 |
| conditional | 能在列明的假设下计算；不是通过。所有计算放在 conditionalCalculations 中 |
| insufficient | 当前条件仍不足以给出计算 |
| not_found_in_checked_scope | 在已检查文字范围没有找到所需明确字段，不宣称整篇文献缺失 |
| not_linked | 定位/名称到分子式/修改条件等关联尚未解决 |
| ambiguous | 多个解释、基准候选或来源内部冲突 |

条件性计算的 `conditionalNumericStatus` 区分全部保留解释相容、全部出现数值差异、结果依赖解释；即使全部相容也不自动通过。实际复算与条件性复算分别统计。

`paper_audit_experiment_context` 仅用于**用户明确给出的解释**，不能由模型自行确认。`contextJson` 示例：

```json
{
  "scope":"method",
  "documentId":"实际文档ID",
  "methodLabel":"A",
  "limitingAmountMmol":0.20,
  "stoichiometricFactor":1,
  "reason":"用户根据反应式确认限制试剂和每摩尔底物对应产物计量",
  "citations":[{"blockId":"实际原文块ID","start":0,"end":10,"quote":"必须逐字对应的原文"}]
}
```

单条记录使用 `scope=record`、`recordId`，可提供 `neutralFormula`，或限制试剂用量/计量系数。通用方法不允许统一设置产物分子式。引用必须对应当前记录或方法的真实证据，示例 ID/偏移不可直接使用。该操作记录的是用户解释，逐字引文校验不能代替化学判断。

每次同范围确认是当前完整选择，之前的决定仍保留。保存后重新运行核对。确认绑定来源哈希，修改原件即失效，旧报告保持快照；需要重新确认。即使用户确认了基准，也不会自动抹去方法中其他 mmol/equiv 矛盾。

CLI：`experiment-context --project ID --run ID --file CONTEXT.json`。查看提取结果仍用 `paper_audit_experiments` / CLI `experiments`。

## 本次验证的实际边界

受控测试覆盖明确方法继承、局部覆盖、重复方法、量纲换算、直接 mmol 收率、盐/水合物、离子式歧义、普通 pure 与真实纯度描述的区别、用户确认与失效。

私有论文在未补任何用户假设的情况下：此前 97 组检查记录全部无法直接计算；新版新增识别数字编号产物的 2 组收率记录，共 99 组。其中 93 组提供条件性计算、6 组仍无法计算，明确条件复算为 0。不能把 93 组称为核验通过；3a 的 85.5% 仍带基准/计量和方法内部冲突提示。真实材料与运行报告不随公开仓库分发。
