# 图像表格读取（0.2.0）

图像表格在本地通过实际 OCR 读取，用户在 Harness 内选择页码或嵌入部件、查看候选单元格与位置，再确认字段对应。没有网页面板，也不需要把图片发到额外云服务。

## 支持范围

- PDF：先列页码候选；显式选择至多 10 页后，使用 PDF.js 以受限分辨率渲染 PNG。选中的整页未必是表格，可在 OCR 时用像素矩形裁剪。
- DOCX：列出 `word/media/` 部件及其 rId、XML 偏移、邻近文字；显式选择至多 20 个部件后转换。不会默认对所有 NMR 谱图运行表格 OCR。
- PNG、JPEG、BMP、WebP：本地栅格输入。TIFF 支持有界单帧图像，不静默丢弃多帧；BigTIFF、递归子目录/EXIF 和超出像素预算的文件明确拒绝。
- DOCX 的 EMF/WMF：Windows 使用系统 GDI 在独立隐藏进程中转换 PNG；其他平台或转换失败时明确显示 failed，需提供已导出的 PNG/PDF。
- 全网格表格：依据像素网格线和 OCR 单词中心恢复行、列及空单元格。
- 无边框表格：按文字行及重复横向位置给出候选列。合并单元格、多级表头、脚注和复杂化学结构不自动确证。

本版用本地 English traineddata，主要适用于英语科研表格和阿拉伯数字。中文标签、特殊字符、上下标、不等号、小数点和扫描噪声需要人工核实。OCR 的 confidence 只是引擎分数，不是科学正确率。

## 核心接口

`inspectVisuals({filePath, documentId, outputDir, selection: {pages?, parts?}, signal?})` 返回候选、已生成图像资产、来源/图像哈希、页码或部件定位及覆盖范围。无 selection 只清点 PDF/DOCX，不自动解读全部图像。

`readImageTable({imagePath, outputDir, tableId?, crop?: {x,y,width,height}, signal?})` 返回真实 OCR 的 rows/cells、原始识别文字、像素 bbox、confidence、图像哈希、处理方式和注意事项。crop 使用已渲染图像的整数像素坐标，bbox 返回相对于完整输入图像的位置。

原文档哈希与渲染图像哈希是不同字段：资产中的 sourceSha256 指原 PDF/DOCX，资产 sha256 指渲染 PNG；OCR 结果的 sourceSha256 指实际输入栅格图像。调用方应把两级证据关系一起保存。

DOCX 的 paragraph 是 XML 中 w:p 出现次序，包含图形内部段落，不等同于 Word 页码或文本解析器块编号。精确追踪以原件哈希、media part、relationshipId 和 xmlOffset 为准。

每个 OCR 表格始终为 needs_review；空图或没有可读词时为 failed。自动识别不能直接升级为已经验证的原始测量，进入数值核对前应确认表头、列角色、单元格数值及实验身份。该语义准入由插件服务层管理。

## 数据路径与边界

Tesseract.js worker、WASM 核心和 `@tesseract.js-data/eng` 都从已安装的本地依赖加载，显式指定 workerPath/corePath/langPath，不依赖运行时 CDN 下载。识别时不发起模型请求或图片上传。第一次安装依赖需要正常下载软件包。

文件上限：DOCX 128 MiB、其他图像/PDF 32 MiB。图像最多 20,000,000 像素、单边 12,000 像素；PDF 按此预算降低渲染比例。DOCX 只提取用户选定且有界的媒体，复用 ZIP 路径、尺寸和 CRC 校验，不执行 OLE。OCR 总预算 90 秒，支持取消。

预处理生成独立副本并屏蔽检测到的网格线，原图和原文件不变；这一步也可能影响靠近边界的符号，所以原图哈希和预处理路径保留供复核。资产输出目录须由服务层限制在当前项目内部。

## 实测与限制

自动测试包含实际离线网格表 OCR、无边框候选列、PNG/JPEG/TIFF、实际 PDF 页渲染、DOCX 部件选择、空图、非法裁剪、取消和来源不变检查，不采用手工填写单元格来伪装 OCR 成功。

真实原 SI 的 153 个媒体部件已清点，选择其中 `image1.emf` 成功转换为 2793×759 PNG；它是反应示意图，不被宣称为表格。本次在 Table S1 标题附近没有找到对应图像锚点，不能从标题虚构表体、条目或收率。需要含实际表体的图片或 PDF 才能进一步读取该表。

原件清单与转换记录保存在开发者本地 `outputs/real-paper-v0.2.0/images/`，未随公开仓库或安装包发布。该路径只是历史记录位置，不是公开下载链接；私有原件也不提供下载。

公开源码中的图像测试使用合成栅格及容器。在仓库运行 `npm ci` 后，可复跑：

```powershell
node --test tests/image-tables.test.js tests/visual-service.test.js
npm run test:harness
```

上述命令执行实际 OCR、来源与复核状态检查；宿主冒烟使用合成表格，不请求模型。读者本地生成的结果不等同于对历史私有论文的表格完成验收。

## 官方实现参考

- [Tesseract.js API](https://github.com/naptha/tesseract.js/blob/master/docs/api.md)：worker、识别输出、路径配置及终止。
- [本地 traineddata](https://github.com/naptha/tessdata/blob/gh-pages/README.md)：可使用 npm 安装的语言数据，不必依赖 CDN。
- [PDF.js Node 渲染示例](https://github.com/mozilla/pdf.js/blob/master/examples/node/pdf2png/pdf2png.mjs)。
- [UTIF.js](https://github.com/photopea/UTIF.js)：IFD、像素解码和 RGBA 转换。
