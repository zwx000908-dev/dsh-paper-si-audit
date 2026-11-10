# 发布与安装规范

本项目发布为 DeepSeek Harness **bundle 插件**。插件版本为 **0.2.0**，兼容目标为 **0.2.2-rc.1**，Node.js 要求为 **24.9.0+**。源码仓库、可安装包、GitHub Release 和插件索引收录是不同事项。

## 官方要求与本项目实现

以 [精确目标版本的打包与安装教程](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/docs/user/develop/basic/publish.zh.md) 为依据，不用第三方教程扩大兼容范围。

| 检查 | 本项目实现 |
|---|---|
| 包声明为 bundle | package.json 的 dsh.bundle.patch 指向 ./cordis.patch.yml；不把用户 profile 打包成插件 |
| patch 按包名挂载 | cordis.patch.yml 插入 paper-si-audit 行，name 为 dsh-paper-si-audit |
| 入口与资源真实存在 | main 指向 src/plugin.js；files 包含 src、patch、规则、技能和文档；打包后解包检查入口与全部运行资源 |
| 宿主版本约束 | engines.dsh 固定 0.2.2-rc.1；不因新版本发布而默认宣称兼容 |
| 共享宿主服务的依赖声明 | 实际运行时 import 的 dsh-tools / schemastery 同时列于 peerDependencies 与 devDependencies；独立解析/OCR库列于 dependencies |
| GitHub 安装可直接加载 | 插件以已提交的 JavaScript 为入口，不依赖 TypeScript 构建产物，不添加形式化 prepare 脚本 |
| tarball 包含安装入口 | pack:verify 先生成 .tgz，再检查 manifest、patch、数据表、图像资源、22个工具定义和质量计算入口 |
| profile 配置由安装方管理 | 插件默认 allowedRoots 为空；不替换用户 profile，不携带机器路径或凭据 |

官方文档对需要构建的 Git 依赖要求自包含 prepare，并说明 pnpm 的构建授权。本项目的 JavaScript 入口不需要该构建步骤；依赖的软件包仍由包管理器正常安装，离线 OCR 指安装完成后的识别过程不依赖 CDN 或云 OCR。

## GitHub 展示与发现

[官方 CONTRIBUTING](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/CONTRIBUTING.md) 推荐使用 GitHub topic **dsh-plugin** 方便发现。仓库同时可添加 deepseek-harness、manuscript、hrms 等主题。

repository、homepage、bugs、keywords、更新记录、图标、locale 展示信息和 CI 是本项目为可发现性、说明和复跑提供的发布材料；不能把这些字段说成官方审核通过证明。图标与 locale 文件属于可选展示资源，随安装包一起提供。

公开仓库只包含插件源码、合成测试、规则示例和脱敏文档。真实论文、谱图、报告、项目状态、开发者机器记录、.env 文件和依赖缓存不提交，也不进入 Release 安装包。

### 第三方发布实践对照

2026-11-09 对照以下插件作者自己的仓库；这些例子说明常见分发方式，不增加官方强制字段：

| 插件 | 已核对的发布实践 | 本项目采用的做法 |
|---|---|---|
| [dsh-find-plugin](https://github.com/awesome-dsh-plugin/dsh-find-plugin) | 通过源码仓库说明安装，当次检查没有 GitHub Releases | 提供仓库入口和明确安装说明；不把创建 Release 当成 bundle 可安装的前提 |
| [dsh-mcphub](https://github.com/jinhongxun/dsh-mcphub) | 纯 JavaScript 插件，当次检查没有 GitHub Releases | 提交可直接加载的 JavaScript；无需为形式增加 TypeScript 构建步骤 |
| [relay-dsh-plugin-codex v0.1.5](https://github.com/yangbobo2021/relay-dsh-plugin-codex/releases/tag/v0.1.5) | 使用固定版本 tag 与 GitHub Release 记录分发版本 | 用与 manifest 一致的 tag，提供安装 tarball、更新说明和 SHA256 |

本项目提供 GitHub 固定版本与可安装 tarball 两条路径；安装成功、目标宿主验证通过和具体索引收录状态分别记录。

## 两种固定版本安装

通过 GitHub 源安装独立 CLI profile：

```powershell
dsh --version
dsh plugin --profile paper-audit add github:zwx000908-dev/dsh-paper-si-audit#v0.2.0
```

也可从 [v0.2.0 Release](https://github.com/zwx000908-dev/dsh-paper-si-audit/releases/tag/v0.2.0) 下载安装资产，核对 SHA256 后安装：

```powershell
dsh plugin --profile paper-audit add ./dsh-paper-si-audit-0.2.0.tgz
```

高可复现性安装可将 tag 改为 Release 对应的完整 commit SHA。不要将 GitHub 自动生成的 Source code 压缩包与可安装 .tgz 混淆。

这两条命令管理 paper-audit profile，不代表 desktop profile 已更新或启用。桌面版按其插件管理入口安装并配置 dataDir / allowedRoots，重开会话后确认22个原生工具；详见 [HARNESS](HARNESS.md)。

## 作者的发布检查

从独立公开源码目录运行：

```powershell
npm ci
npm run check
npm test
npm run test:harness
npm run pack:verify
```

pack:verify 会创建 dist 目录，执行 npm pack --ignore-scripts，然后检查真实 .tgz 的内容及可导入入口。它生成版本化安装包、SHA256 清单与包内容元数据；公开元数据只使用相对入口路径，不包含开发者本机解包路径。

发布源码 commit 和与 package.json 一致的 v0.2.0 tag；GitHub Release 附上 dsh-paper-si-audit-0.2.0.tgz、SHA256SUMS-0.2.0.txt 和可选的 package-metadata-0.2.0.json。上传后应从 Release 下载安装包并复核哈希，另行验证固定 commit 的 GitHub 安装路径。源码测试通过不能替代远程发布物检查。

仓库包含 Windows / Node24 CI，执行语法、合成测试、精确目标 Harness 原生流程和打包检查。实际状态以该 commit 的 Actions 结果为准；不能在首次远程运行前宣称云端 CI 已通过。

## 可选插件索引

[目标版本的插件市场说明](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/docs/user/guide/plugin-market.zh.md) 将索引视为可选、实验性机制，默认没有官方 source。GitHub 仓库与 Release 发布成功不等于已被索引收录，更不等于官方认证。

如果后续维护插件索引，应按该索引的格式生成条目，并将源版本固定到完整40位 commit。索引名称、收录规则、维护人及审核状态由具体索引决定。本次发布不声称已向任何市场申请或获得审核。
