# 原生工具激活诊断

Paper–SI Audit 的“包已安装”“组合包已选中”“源目录已配置”“本会话工具已注册”是四个不同状态。

直接调用 `src/service.js` 的 `AuditService` 可以检验同一核心算法及报告流程，但不会检验 Harness 的工具发现、提示词注入、参数准入、配置组合、权限及生命周期。因此核心库核对与原生会话验收应分别记录，不能以“产物等价”代替后一项。

## 历史诊断案例（2026-11-09）

- 一次开发者本地只读诊断中，桌面内置 CLI 返回 **0.2.2-rc.1**，已不同于最初开发时的旧版观察。
- 该环境的 desktop profile 声明并安装了 `dsh-paper-si-audit` 0.1.0，包内 `dsh.bundle.patch` 有效。
- 该 profile 的 `dsh.profile.bundles` 未包含插件，`allowedRoots` 为空，已检查的 profile/home 层也没有相关配置覆盖。
- 诊断没有修改安装、启用状态或目录授权。这是历史故障案例，不代表读者当前环境。

`allowedRoots: []` 会阻止读取论文，但**不会单独导致工具不注册**：插件加载后可先注册工具，导入文档时才要求授权路径。缺少 bundle 选择足以解释未从该组合包加载；还需结合实际会话判断其他加载/限制条件。旧 0.1.x 有 14 个工具，0.2.0 有 22 个。

原始诊断记录、项目标识和论文材料保留在开发者本地，未随仓库或安装包发布。下列命令可检查读者自己的环境，不依赖该私有案例。

## 只读诊断命令

```powershell
node scripts/doctor-harness.js --profile desktop
```

诊断按显式 `--home`、`DSH_HOME`、`~/.dsh` 的优先级选择配置根。Windows 默认检查 `%LOCALAPPDATA%/Programs/DeepSeek Harness` 下已安装的桌面 CLI 版本；可用 `--desktop-dir` 指定实际安装目录。不会用工作区 devDependency 的版本冒充当前桌面版本。

输出只包含所选包的安装/启用状态、相关配置字段和版本，不打印整个 profile、其他插件设置、凭据或环境变量。脚本不会 import 已安装插件，也不执行配置中的 `!!js`、宏或自定义 tag。

需要预览目录配置时：

```powershell
node scripts/doctor-harness.js --profile desktop --source-root "D:/Research/selected-manuscript" --data-dir "D:/PaperAudit/projects"
```

输出的 patch 只是待审阅预览，不写入磁盘，不授予读取权限。静态诊断不完整求值其他组合包、启动时 `--patch` 或会话工具限制；它不能证明当前会话已注册工具。

## 启用的正确入口

在对应 **desktop profile** 的 Harness 插件管理中找到已安装包并启用，再配置完整的绝对 `dataDir` 和 `allowedRoots`。按宿主反馈重开会话或重启。具体启用操作会改变该 profile 的其他会话，应在用户明确要求后执行，不通过本诊断脚本静默修改。

`dsh plugin --profile paper-audit add ...` 创建/管理的是名为 `paper-audit` 的独立 profile，**不会自动启用正在运行的 desktop profile**。旧安装示例仅适用于独立 profile；不能将它作为桌面启用的充分步骤。

上游 0.2.2-rc.1 的 plugin manager 有原生 bundle 启用操作，应优先使用宿主管理流程。不要简单追加一个只含 `allowedRoots` 的新 `config` 而丢掉需要保留的 `dataDir`：profile patch 会替换整份 config。不要替换整份 `package.json` 或 profile patch 来启用一个插件。

安装并启用 0.2.0 后，确认当前会话可发现全部 22 个 `paper_audit_*` 工具，再运行一次原生完整流程。旧 0.1.x 为 14 个；只读诊断会按已安装版本披露数量，不把新包开发完成当作桌面已经更新。若改用 core API，报告应记录 core API 和未完成的原生验收范围。

## 对照的精确上游机制

- [0.2.2-rc.1 官方源码](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.1)
- [组合包与 profile 安装机制](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/docs/user/develop/basic/publish.zh.md)
- 本地精确 `@deepseek-ai/dsh-app-boot@0.2.2-rc.1` 的 `readProfilePlugins` 分别读取已安装 metadata 与 `dsh.profile.bundles`；`reconcileProfilePlugins` 可能按 `preserveDisabled` 保留停用状态。仅从当前静态文件不能确定当初未启用的具体原因。
