# Unreal Plugin Pipeline

<p align="center">
  <a href="README.md">English</a> | <strong>简体中文</strong>
</p>

面向 Windows 的 Codex 插件，用于批量构建、修复和打包 Unreal Engine `.uplugin` 插件。

它把 Unreal 插件发布流程整理成一套可重复执行的本地流水线：检测本机 Unreal Engine 安装、按版本从低到高执行 `RunUAT.bat BuildPlugin`、生成 zip 包和日志，并可在 Codex 中触发自动构建/修复循环。

本项目全程使用 Codex 与 GPT-5.5 模型开发，包括需求梳理、插件结构设计、Node.js/PowerShell 脚本、Codex skills、测试用例和文档编写。这个插件本身也推荐通过 Codex 自我部署：在 Codex 中打开本仓库，让 Codex 执行 marketplace 注册、目标 Unreal 插件 setup、引擎检测和后续构建流程。

![Unreal Plugin Pipeline](assets/unreal-plugin-pipeline.svg)

## 功能特性

- 自动发现本机 Unreal Engine 安装目录，并按版本排序生成构建计划。
- 支持全局和项目级配置：输出目录、排除版本、zip 命名规则。
- 支持单个插件项目 setup，也支持批量扫描一个插件目录。
- 提供直接构建模式：调用 Unreal `RunUAT.bat BuildPlugin` 打包插件。
- 提供 Codex 代理构建模式：构建失败后让 Codex 读取日志、修复代码、重试当前版本。
- 提供本地配置面板：查看引擎、命令、输出目录、Run action 状态并保存配置。
- 默认只写项目本地配置；Run dropdown 动作是显式 opt-in 的兼容方案。

## 为什么不是官方插件那种 Action Bar 按钮

Codex 官方内置插件可以使用一些宿主侧 UI 能力，例如自动出现在 action bar 或官方设置面板中。当前本地/第三方 Codex 插件元数据并没有公开等价的桌面 UI 扩展点，因此这个项目不能像官方插件一样自动添加独立 action bar 按钮，也不能把配置页直接注入 Codex 官方设置面板。

这个限制不是脚本缺失，而是插件能力边界：

- `.codex-plugin/plugin.json` 可以声明插件名称、图标、分类、skills 和默认提示词。
- skill-agent 入口可以显示为可调用的插件动作，例如 `Build Plugin`、`Detect Engines`、`Show Config`。
- 项目级 Run dropdown 动作只能通过显式安装写入目标项目的 `.codex\environments\environment.toml`。
- 官方设置面板没有面向本地插件开放的可写配置页 API。
- 直接修改 `C:\Users\<you>\.codex` 里的 Codex Desktop 全局 UI 状态不是受支持的插件实现方式，容易影响所有项目，甚至破坏 Codex 启动/会话行为。

因此本项目采用受支持且可回滚的方式：用 Codex 插件分类入口和 skills 作为主入口，用本地 loopback dashboard 作为配置面板，用显式 opt-in 的 Run dropdown 动作做兼容方案。

## 适用范围

当前版本专注于：

- Windows
- Unreal Engine 插件项目
- 项目根目录下有 `.uplugin` 描述文件
- Unreal Automation Tool 的 `BuildPlugin` 打包流程
- Codex Desktop / Codex CLI 的本地插件工作流

当前版本不提供 macOS / Linux 支持，也不能为 Codex Desktop 创建独立工具栏按钮。可选 Run actions 会出现在 Codex 内置 Run dropdown 中。

## 目录结构

```text
.
├─ .codex-plugin/plugin.json              # Codex 插件元数据
├─ assets/                                # 插件图标
├─ commands/                              # Codex slash command
├─ scripts/
│  ├─ invoke-unreal-plugin-pipeline.ps1   # Windows PowerShell 启动器
│  ├─ install-run-actions.ps1             # 受保护的 Run actions 安装器
│  └─ unreal-plugin-pipeline.mjs          # 核心 Node.js CLI
├─ skills/                                # Codex skill 入口
└─ tests/                                 # Node.js 测试
```

`plugins/unreal-plugin-pipeline/` 下保存了一份可作为本地 marketplace 使用的插件包镜像。

## 环境要求

- Windows 10/11
- PowerShell
- Node.js 18 或更高版本
- 一个或多个 Unreal Engine 安装，目录中需要存在 `Engine\Build\BatchFiles\RunUAT.bat`
- 目标项目根目录下存在 `.uplugin` 文件

如果要使用 Codex 代理构建模式，还需要安装独立 Codex CLI：

```powershell
npm install -g @openai/codex
codex --version
```

Codex Desktop 自带的 WindowsApps 资源不是可用于此流水线的 `codex exec` CLI。如果只想直接调用 Unreal 打包，使用 `build-only` 即可。

## 安装为本地 Codex 插件

推荐全程让 Codex 自我部署本插件：在 Codex 中打开本仓库，然后要求 Codex 将当前仓库注册为本地 marketplace、安装 `Unreal Plugin Pipeline`，再对目标 Unreal 插件项目执行 setup。这样后续检测引擎、打开配置面板、构建和失败修复都能保持在 Codex 对话中完成。

把本仓库加入 Codex 本地 marketplace：

```powershell
codex plugin marketplace add "D:\Path\To\UnrealPluginPipline"
```

然后在 Codex 插件界面中安装 `Unreal Plugin Pipeline`。安装完成后，Codex 插件页会增加新的本地插件来源/分类下拉项，显示为 `Unreal Plugin Pipeline Local`；按当前元数据，插件归类在 `Coding` 分类下。部署完成后，可以从这个下拉入口选择该插件，并使用它提供的动作入口。

插件提供的主要入口包括：

- `Build Plugin`：在当前对话中构建插件，失败时分析日志、修复并重试。
- `Detect Engines`：显示检测到的 Unreal Engine 版本和最终构建顺序。
- `Show Config`：打开本地配置面板。
- `Install Run Actions`：显式安装 Codex Run dropdown 动作。
- `Uninstall Run Actions`：移除本插件写入的 Run dropdown 动作。

## 快速开始

假设目标 Unreal 插件位于：

```text
D:\Path\To\MyPlugin
```

先为项目写入本地配置：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\invoke-unreal-plugin-pipeline.ps1 -PipelineCommand setup -ProjectRoot "D:\Path\To\MyPlugin"
```

检测可用引擎和构建顺序：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\invoke-unreal-plugin-pipeline.ps1 -PipelineCommand detect-engines -ProjectRoot "D:\Path\To\MyPlugin"
```

直接用 Unreal 打包：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\invoke-unreal-plugin-pipeline.ps1 -PipelineCommand build-only -ProjectRoot "D:\Path\To\MyPlugin"
```

打开配置面板：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\invoke-unreal-plugin-pipeline.ps1 -PipelineCommand dashboard -ProjectRoot "D:\Path\To\MyPlugin"
```

## 常用命令

所有命令都通过 PowerShell 启动器调用。启动器会从 `UPP_NODE_EXE`、PATH 和常见 Node.js 安装位置解析可用的 `node.exe`。

下表展示的是 `-PipelineCommand` 及其参数；实际运行时在前面加上 `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\invoke-unreal-plugin-pipeline.ps1 -PipelineCommand`。

| 操作 | PipelineCommand 参数 |
| --- | --- |
| 初始化单个插件项目 | `setup -ProjectRoot "D:\Path\To\MyPlugin"` |
| 批量初始化目录下的插件 | `setup-all --root "D:\Path\To\Plugins"` |
| 检测引擎 | `detect-engines -ProjectRoot "D:\Path\To\MyPlugin"` |
| 直接构建所有可用版本 | `build-only -ProjectRoot "D:\Path\To\MyPlugin"` |
| 直接构建指定版本 | `build-only -ProjectRoot "D:\Path\To\MyPlugin" --engine-version 5.7` |
| 启动 Codex 代理构建 | `build -ProjectRoot "D:\Path\To\MyPlugin"` |
| 打开配置面板 | `dashboard -ProjectRoot "D:\Path\To\MyPlugin"` |
| 只生成静态面板 HTML | `dashboard -ProjectRoot "D:\Path\To\MyPlugin" --no-open` |
| 显示当前配置 JSON | `show-config -ProjectRoot "D:\Path\To\MyPlugin"` |
| 移除 Run actions | `uninstall -ProjectRoot "D:\Path\To\MyPlugin"` |

完整调用示例：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\invoke-unreal-plugin-pipeline.ps1 -PipelineCommand build-only -ProjectRoot "D:\Path\To\MyPlugin" --engine-version 5.7
```

## 引擎发现

默认会扫描以下全局目录：

```text
D:\Epic\Epic Games
C:\Program Files\Epic Games
```

添加新的扫描目录：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\invoke-unreal-plugin-pipeline.ps1 -PipelineCommand add-scan-root --root "D:\Epic\Epic Games"
```

添加明确的引擎目录：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\invoke-unreal-plugin-pipeline.ps1 -PipelineCommand add-engine-root --root "D:\Epic\Epic Games\UE_5.7"
```

排除或重新包含某个版本：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\invoke-unreal-plugin-pipeline.ps1 -PipelineCommand exclude-version -ProjectRoot "D:\Path\To\MyPlugin" --version 5.1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\invoke-unreal-plugin-pipeline.ps1 -PipelineCommand include-version -ProjectRoot "D:\Path\To\MyPlugin" --version 5.1
```

加上 `--global` 可以把版本排除规则写入全局配置。

## 输出目录

设置全局输出目录：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\invoke-unreal-plugin-pipeline.ps1 -PipelineCommand set-output --output "D:\UnrealPluginBuilds\{pluginName}"
```

构建日志和报告写入输出目录：

```text
<output-directory>\logs\<PluginName>-UE<Version>.log
<output-directory>\reports\last-release-report.md
```

这些文件不会写入目标插件项目的 `.codex` 目录。

## 配置文件

全局配置：

```text
%USERPROFILE%\.unreal-plugin-pipeline\config.json
```

项目配置：

```text
<plugin-root>\.codex\unreal-plugin-pipeline.json
```

输出目录和 zip 命名规则只保存在全局配置中，便于统一管理所有插件构建产物。项目配置可以只为当前插件排除某些 Unreal Engine 版本。

## Run Dropdown 兼容模式

默认 `setup` 只写项目本地配置，不会创建 Codex Run dropdown 动作，也不会把运行脚本复制到 Unreal 插件项目中。

如果确实需要在 Codex 内置 Run dropdown 中显示 `Build`、`Build Only`、`Detect Engines`、`Show Config`，可以显式安装：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-run-actions.ps1 -ProjectRoot "D:\Path\To\MyPlugin"
```

如果传入的是包含多个插件的父目录，需要指定插件名：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-run-actions.ps1 -ProjectRoot "D:\Path\To\Plugins" -PluginName "MyPlugin"
```

安装和卸载只允许修改目标插件根目录下的：

```text
<plugin-root>\.codex\environments\environment.toml
```

不会修改父级 workspace 的 `.codex\environments\environment.toml`。

## 安全边界

`Build` 代理模式会启动：

```text
codex exec --full-auto --sandbox workspace-write -c approval_policy="never"
```

它只会通过 `--add-dir` 添加必要目录，包括：

- 配置的输出目录
- 配置的 Unreal Engine 根目录
- Unreal 构建需要的用户状态目录：
  - `%APPDATA%\Unreal Engine`
  - `%LOCALAPPDATA%\UnrealEngine`
  - `%LOCALAPPDATA%\Microsoft SDKs`

流水线不会使用 `--dangerously-bypass-approvals-and-sandbox`。

构建失败时，Codex 代理应读取输出目录下的日志，修复当前项目，重试失败版本，然后继续后续版本。它不应重置或回滚用户改动。

## 开发与测试

安装依赖不是必须的；当前测试直接使用 Node.js 内置测试运行器。

```powershell
npm test
```

等价于：

```powershell
node .\tests\unreal-plugin-pipeline.test.mjs
```

## 贡献方式

本项目是 Codex 插件，默认所有使用者都已经拥有 Codex，并且能够在 Codex 中复现部署、构建和修复流程。因此本仓库不接受 GitHub issue 作为支持或需求沟通渠道。

如果你发现问题或想改进功能，请直接提交 pull request。PR 应尽量包含：

- 变更说明
- 复现方式或使用场景
- 对应测试，或说明为什么不需要新增测试
- 对 `README_CN.md` / `README.md` / skill 文档的必要更新

这能保持项目维护方式和插件使用方式一致：问题由 Codex 辅助定位，修复以可审查的代码变更进入仓库。

## 发布前注意

- 这个仓库当前是 Windows-first，本 README 不描述跨平台支持。
- 如果发布到公开 GitHub，建议补充根目录 `LICENSE` 文件；插件元数据当前声明为 MIT。
- 如果仓库路径或名称变化，请同步更新示例中的本地 marketplace 路径。
