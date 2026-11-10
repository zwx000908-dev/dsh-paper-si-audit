# 核磁—分子式相容性与科研图片重复检查

这两项检查通过 Harness 原生工具执行，结果进入同一份 Markdown/JSON/CSV 报告。疑点保持 `needs_review`，不会改写原始论文或推断科研不端。

## 核磁数据

`paper_audit_run` 自动检查可解析的文字表征。每个 ¹H 实验独立求和各组 `nH` 积分；某一组没有积分时，整个实验记为信息不足，不用部分积分冒充总数。积分差异超过 0.05 H 时列出疑点；这是软件比较容差，不是期刊要求。氘和氚不计为 ¹H。

¹³C 列表按信号组计数，`(d, J = …)` 等多重峰计一组，显式 `(2C)` 按两个碳计。超过分子式碳数时提示；少于碳数不单独判错，因为对称性、重叠或未观察到的碳均可能减少信号。交换氢、杂质、混合物、构象异构体及归一化也需结合原始数据判断。

分子式来自同一记录的明确 `molecular formula: …`、`formula: …`、`分子式：…` 或可解析的 HRMS/MS 记录。中性式直接使用；最终离子式通过已标注的加合物/损失/聚集数反推分子组成。不明确的 MS 口径保留全部候选，绝不依照积分或质量接近程度选择答案。

跨段落只连接明确化合物标题与紧随的分析段落；中间有未知文字、其他化合物或记录边界时不猜测归属。未支持的写法、缺少积分、缺少分子式均单独列为信息不足。原图中的核磁谱线不在本功能中自动拾峰；不根据分子式预测结构、化学位移、偶合关系或证明结构正确。

科学依据：[ACS 的 NMR 技术介绍](https://inchemistry.acs.org/college-life/know-your-techniques-nmr.html)说明积分与等价质子的关系；[University of Colorado 的 ¹³C 积分说明](https://www.orgchemboulder.com/Spectroscopy/nmrtheory/integC13.shtml)区分碳谱积分与受对称性影响的信号数。软件规则是有边界的计数筛查。

## 图片重复

1. 导入正文、SI 及用户选择的独立图片。
2. 从 `paper_audit_project` 获取来源 `documentKey`，对每个来源调用 `paper_audit_prepare_image_audit`（`offset=0, limit=10`）。跟进 `nextOffset` 直至空值。该过程只渲染图片，不执行表格 OCR。
3. 调用 `paper_audit_run`。检查 `coverage.imageDuplicates`，包括未建清单文档、未读/转换失败素材、过期素材及超限数。最多比较前 200 个登记素材，最多 19,900 对；大项目应拆分。
4. 读取 `paper_audit_issues` 中 `category=image_duplicate` 的问题，按照 `imageEvidence` 中的 assetId 调用 `paper_audit_visual_image` 阅读两端；Markdown 报告有本地原图链接、来源位置与哈希，JSON 保留完整快照。表格 OCR 无需执行或确认即可查重。

判定包括解码铺白底后的完整像素一致，以及 32×32 灰度归一化后的相似候选。后者枚举四种直角旋转及镜像，兼容整体缩放，使用归一化 RMSE ≤ 0.10、宽高比误差 ≤ 3% 的软件阈值；低对比度或近空白素材不进行近似匹配。分数是距离，不是概率。相似的谱图、图表或共享版式仍可能误报，较大编辑可能漏检。

DOCX 提取内嵌媒体并保留所有已识别正文 XML 位置。同一媒体多处出现也会提示。当前不遍历页眉页脚、OLE 或所有矢量内容。EMF/WMF 仍依赖 Windows 转换。PDF 当前渲染整页，不能保证找出页面局部图片的复用；需面板级比较时，请单独导入导出的面板图片。局部裁剪重复、拼接、重度修饰及任意角度旋转不属于已验证能力。

重复可能是正文/SI 复用、同一对照、标志或合理引用。插件只能定位相同/相似内容，是否应当修改需检查图注、样品及实验来源。

CLI 批处理入口：

```powershell
node src/cli.js prepare-image-audit --data DATA_DIR --root SOURCE_DIR --project PROJECT_ID --document DOCUMENT_KEY --offset 0 --limit 10
node src/cli.js run --data DATA_DIR --root SOURCE_DIR --project PROJECT_ID
```
