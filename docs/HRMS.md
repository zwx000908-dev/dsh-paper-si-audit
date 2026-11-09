# HRMS / MS 分子式精确质量复算

本模块执行确定性的同位素质量加和、离子电荷修正与 m/z 误差计算。它不推测分子结构、仪器分辨率、样品身份或分子式是否真实。

## 数据来源与约定

离线快照 `src/isotope-masses.json` 于 2026-11-09 核对，采用 NIST 的**中性原子同位素质量**，不使用平均原子量。未指定同位素时使用快照中该元素最丰同位素；这不是完整分子同位素包络或最强峰预测。

- [NIST 同位素质量定义](https://www.nist.gov/pml/atomic-weights-and-isotopic-compositions-column-descriptions)：质量基于中性基态原子的相对质量。
- 每种元素数据来源为 `https://physics.nist.gov/cgi-bin/Compositions/stand_alone.pl?ele=元素符号`，例如 [H](https://physics.nist.gov/cgi-bin/Compositions/stand_alone.pl?ele=H)、[C](https://physics.nist.gov/cgi-bin/Compositions/stand_alone.pl?ele=C)、[N](https://physics.nist.gov/cgi-bin/Compositions/stand_alone.pl?ele=N)、[O](https://physics.nist.gov/cgi-bin/Compositions/stand_alone.pl?ele=O)、[Na](https://physics.nist.gov/cgi-bin/Compositions/stand_alone.pl?ele=Na)。快照中 30 种元素均按同一官方表逐项核对。
- [NIST 2022 CODATA 完整常数表](https://physics.nist.gov/cuu/Constants/Table/allascii.txt)的电子质量：`0.0005485799090441 u`，标准不确定度 `0.0000000000000097 u`。快照记录调整版次与来源。

计算约定为：

```text
离子质量 = 最终离子组成的中性原子同位素质量之和 − z × 电子质量
m/z = 离子质量 / |z|
ppm = (原文数值 − 理论 m/z) / 理论 m/z × 10^6
mDa 差值 = (原文数值 − 理论 m/z) × 1000
```

这是常见的原子质量加和约定，不模拟分子结合能或原子电离结合能。氢原子质量减电子质量与独立自由质子的物理质量有约 10^-8 u 的差异；本模块保持一种一致约定，不在不同加合物之间混用约定，也不把显示的全部小数当作测量精度。

## 分子式口径必须明确

原文 `calculated C18H22NO3 [M+H]+ ...` 可能把分子式写作：

1. 中性分子组成，此时需要额外加入 H 并扣除电子；
2. 最终离子组成，此时不能再加一个 H。

默认 `formulaBasis: ambiguous` 会列出两种解释及各自误差，保持 `needs_review`，**不会选择更接近原文 calculated 值的一种来反推口径**。显式带净电荷的公式可以约束为离子组成；文字明确写出 `neutral formula` / `ion formula` 或用户明确配置后，才按指定解释给出唯一结果。

API 支持 `formulaBasis: neutral | ion | ambiguous`（`auto` 是 ambiguous 的别名）。指定口径时保留该配置以便追溯。

## 支持的表达

- 30 种元素及快照列出的明确同位素；`[13C]`、`[15N]`、D/T 均可明确指定。
- 正整数原子数、括号分组、中点水合物：`C6H5(OH)3`、`CuSO4·5H2O`。
- 净电荷：`C6H13O6+`、`C6H14O6^2+`、`[C6H14O6]2+`；单元素 `Fe3+` 有计数/电荷歧义，需写 `Fe^3+` 或传 charge。
- 明确加合/损失：`[M+H]+`、`[M+Na]+`、`[M-H]-`、`[2M+H]+`、`[M+2H]2+`、`[M+NH4]+`、`[M+H-H2O]+` 等原子表达。
- 离子分子式模式下，不再次应用 M 的倍数或加合原子；逆向扣除加合物、除以多聚数后必须得到非负整数原子组成，否则明确拒绝该解释。

未知元素、未收录同位素、R/X 等占位、分数计数、未闭合括号、不明电荷及不支持表达会被拒绝或列为覆盖不足，不猜测。水合物要求使用 `·`，不把 `C1.5H2` 等小数点表达猜为整数水合物。

## 模块 API

```js
import { calculateExactMass, checkHrms, massError } from './src/hrms.js'

calculateExactMass({
  formula: 'C6H12O6',
  ion: '[M+H]+',
  formulaBasis: 'neutral',
})

checkHrms(documents, {
  formulaBasis: 'ambiguous',
  ppmTolerance: 5,
  mDaTolerance: null,
})
```

`calculateExactMass` 返回 candidates，每项含最终离子组成、电荷、中性原子组成质量、电子修正、离子质量和 m/z；缺电荷时不会凭空假设 `[M+H]+`。

`checkHrms` 返回 `{ records, issues, coverage }`。records 的 formula、ion、calculated、found 引用各有原始 block ID 与精确字符偏移；calculated 与 found 的误差独立保存。

- **calculated**：检查理论值能否按原文显示位数四舍五入为其报告值，不以仪器 ppm 容差代替理论数的正确呈现。
- **found**：按用户配置的 ppm 容差检查；若同时设置 mDa，需同时符合两个阈值。默认 5 ppm 是软件提示值，**不是自动推断的期刊或仪器标准**。
- EI-MS / ESI-MS 来源标签保持原样，未明确 HRMS 的分辨率标为 unspecified；能复算数值不意味着确认高分辨测量。
- calcd/found 支持小数与科学计数；calculated 的舍入量级包含指数。found 仅读取标记后紧邻数字，不从后续句子、另一个化合物或 NMR 中寻找替代值。foundStatus 区分 reported / unreadable / not_reported，foundCheckStatus 披露是否实际比较。显式 found 但读不到数字会产生覆盖问题。
- 复算候选均保留人工判断边界，不决定应改分子式、加合物、电荷、calculated 还是 found。

## 真实案例范围

开发期间对一份真实 SI 文本快照复跑，保留 45 组 EI-MS calculated/found 记录：44 组分子式口径待确认，1 组原文分子式含空格而列为 unsupported。45 个 found 可读，其中 44 组具备条件比较；这不等于高分辨数据已通过。记录可在用户明确选择口径后重新计算。原件和机器记录保留在开发者本地，未随仓库或安装包发布；匿名化摘要见 [验证记录](VALIDATION.md)。

模块 16 项自动测试覆盖数据来源、同位素、分组/水合物、加合/多电荷与逆向原子一致性、避免重复加 H、分子式歧义、calculated/found 分开检查、科学计数、精确证据跨度、缺失/不支持表达，以及禁止跨句跳读。它们不代表真实论文准确率。

公开源码复跑方式：在仓库执行 `npm ci` 后，运行 `node --test tests/hrms.test.js tests/hrms-service.test.js`。这些合成回归用例不需要私有论文。也可直接使用命令行计算：

```powershell
node src/cli.js hrms-calculate --formula C6H12O6 --ion "[M+H]+" --basis neutral
```
