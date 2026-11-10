# 验证集和评估方法

`npm run evaluate` 运行固定的 14 个合成正负例，分别覆盖核磁计数、收率算术、整图及局部图像相似。输出保存于 `test-output/evaluation/synthetic.json`，这些数值不等于真实论文准确率。

`real-reference.json` 固定一个用户提供论文及原始 SI 的文件 SHA-256、13 个参考案例和预期行为。公开清单不包含论文全文、图片、绝对路径或用户项目数据。标签由助手依据用户此前核对结果和原文逐项整理，**未经过独立专家复核，也不是独立保留测试集**。其中 3 条是应提出的复核疑点、6 条是不应误归属到 3a 的数据，4 条应保留分子式口径不确定性。

拥有对应原件与旧案例目录时可以复跑：

```powershell
node scripts/validate-real-workflow.js "绝对路径/此前案例目录"
node scripts/evaluate.js "绝对路径/outputs/real-workflow-0.4.0/report.json"
```

回放脚本读取旧案例 `state.json` 的 main 和 siOriginal，并验证路径位于其同级 paper 文件夹。只读原件和旧报告，结果另存 outputs。选择四个 SI 谱图媒体及两页正文作为管线检查，不代表全文所有图片已检查。文件哈希不符时，评估拒绝沿用旧标签。

评估报告分别计数 TP、FP、TN、FN、已知案例上的弃判和未知案例上的确定判断。召回率的分母包含正例弃判，避免通过大量不作判断虚增成绩。没有正例或负例时，相应指标为 null。另检查 3a/3b 的文本氢积分及碳信号数是否与参考读取一致。

当前结果：合成 14 例为 TP 8、TN 6、FP/FN 0；真实子集为 TP 3、TN 6、FP/FN 0，另 4 条保留不确定，4 个计数读取断言符合参考。这里的 positive 表示应提出疑点，不表示证明原文的某个值错误。

尚未测得：多篇化学论文全文总体准确率、专家间标注一致性、实际作者复核耗时。多论文图片的外部标注检出评估见下文。扩展数据集时应先固定来源和标签，记录不确定案例，再在开发集之外评估；不能只选已知能检出的例子。


## 外部独立标注：BioFors 测试子集

见 [完整方法与边界](../docs/REVIEW-0.7.md)、[冻结清单](biofors-external.json) 和 [0.7.0 完整基线](biofors-baseline-0.7.json)。外部来源：[作者仓库](https://github.com/vimal-isi-edu/BioFors)、[ICCV 原文](https://openaccess.thecvf.com/content/ICCV2021/html/Sabir_BioFors_A_Large_Biomedical_Image_Forensics_Dataset_ICCV_2021_paper.html)。这是与插件标签生成独立的既有外部标注，不是本次新聘专家的复核，也不是跨化学任务的全面验证。

10 篇真实论文，172 对图像（22 个正例、150 个负例），147 张原图。首次固定默认规则得到 TP 0、FP 0、TN 135、FN 14，正例弃判 8、负例弃判 15。全部输入哈希验证通过；缺失图片不计负例。0% 正例检出率说明当前简单相似算法对该真实子集不足，不能用 14 个合成案例通过来掩盖。

```powershell
python scripts/fetch-biofors.py
npm run evaluate:external
```

`prepare-biofors.py` 记录一次性选择过程，不是日常评估命令；重新运行不应覆盖既有冻结清单。CI 检查清单、标签和结果一致性，默认不下载第三方图像。实际外部评估需要上述独立命令。首次评估后不再把这批已看过的失败案例视作未来算法的盲测集。
