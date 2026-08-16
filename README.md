# dsh-update-checker

DSH 更新检测动态插件（Cordis Plugin）。检测本机安装的 **DSH / `@deepseek-ai` 包**（npm 源）以及 **GitHub 源包**是否有更新，并在设置页提供详细表格与**一键更新**。

## 功能

- **npm 源检测**：读取 profile 的 `node_modules/@deepseek-ai/*` 本机版本，对比 npm registry 的 `latest`（稳定）、`next`（预发布）标签与已发布最高版本。
- **GitHub 源检测**：解析 `pnpm-lock.yaml` 中 `codeload.github.com` 条目得到已安装 commit，用 `git ls-remote`（无 API 限流）获取各仓库默认分支最新 commit 并对比。
- **设置页 UI**（`settings.section`）：
  - 汇总信息（DSH 发行版 / Profile / 检查时间）
  - 状态筛选（全部 / 可更新 / 已最新 / 预发布 / 失败）
  - 按包名搜索
  - npm 与 GitHub 两个详细表格（原生 `<table>`，保证列对齐）
  - 实时检查进度条（阶段 + 当前包名 + 计数）
  - GitHub 可更新项「更新」按钮：在 profile 中执行 `pnpm update <包名>` 升级到最新 commit
- **模型工具**：注册 `dsh_check_updates` 工具，可直接问 Agent“检查有没有更新”。

## 当前检测口径

- npm 包“有更新” = npm 上存在比本机版本更高的已发布版本（`maxPublished > local`）。
- GitHub 包“有更新” = 远程默认分支最新 commit ≠ 已安装 commit。
- 本地 `link:` 安装的 git 仓库（如 `dsh-theme-endfield`）也会检测，但**不提供一键更新**（需手动 `git pull`）。

## 使用方式（作为动态插件）

1. 用 `cordis_define` 定义一个插件：
   - `code.host` = `src/host.js` 中 `export default function () { ... }` 的函数体（即 `const SCRIPT = ...; ...; return { apply(ctx) {...} }`）。
   - `code.client` = `src/client.js` 中 `export default function () { ... }` 的函数体。
2. `cordis_run` 激活（Client 端需批准一次）。
3. 打开 **设置 → 更新检测** 查看结果并点「更新」；或直接说“检查更新”。

> 说明：这是动态（临时）插件，DSH 进程重启后消失。如需长期保留，应写入 profile 的 `cordis.yml` 组合。

## 独立脚本

`src/check-dsh-updates.cjs` 是与插件内嵌检测逻辑一致的独立脚本，可离线运行验证：

```bash
node src/check-dsh-updates.cjs
```

输出 JSON 报告（npm `summary`/`packages` + GitHub `githubSummary`/`github`），并把进度写到 stderr。

## 依赖

- 运行环境：Node.js（子进程执行检测脚本）。
- GitHub 检测依赖 `git`（`git ls-remote`）。
- 一键更新依赖 `pnpm`（在 profile 目录执行 `pnpm update`）。
