# dsh-update-checker

DSH 更新检测插件。检测本机安装的 **DSH / `@deepseek-ai` 包**（npm 源）以及 **GitHub 源包**是否有更新，在设置页给出详细表格，并支持 GitHub 依赖的**一键更新**。

有两种运行形态，功能一致：

| 形态 | 入口 | 生命周期 |
| --- | --- | --- |
| **安装（持久）** | `index.js`（host）+ `client.js`（浏览器） | 写进 profile 的 bundle 栈，重启后依然存在 |
| 动态（临时） | `src/host.js` + `src/client.js` 的函数体 | 由 `cordis_define` / `cordis_run` 装载，DSH 进程重启即消失 |

## 安装到 profile（推荐）

```bash
# 本地开发（link，改完重启 dsh web 即生效）
dsh plugin --profile web add link:E:/dsh/1/dsh-update-checker

# 或从 GitHub 安装
dsh plugin --profile web add github:ymh0000123/dsh-update-checker
```

该命令会把包写进 profile 的 `dependencies`，并根据本包的 `dsh.bundle.patch` 声明把 `dsh-update-checker` 追加到 `dsh.profile.bundles`。profile 启动时合并 `cordis.patch.yml` 里那一行 `insert`，无需手工改 profile 文件。

**装好后需重启 `dsh web` 才会挂载。** 之后打开 **设置 → 更新检测**。

卸载：

```bash
dsh plugin --profile web remove dsh-update-checker
```

## 功能

- **npm 源检测**：读取 profile 的 `node_modules/@deepseek-ai/*` 本机版本，对比 npm registry 的 `latest`（稳定）、`next`（预发布）标签与已发布最高版本。
- **GitHub 源检测**：解析 `pnpm-lock.yaml` 中 `codeload.github.com` 条目得到已安装 commit，再取远程默认分支最新 commit 对比。先用 `git ls-remote`（8s 超时、无 API 限流），失败则**自动回退 GitHub API**（`api.github.com`），因此 `github.com:443` 被阻断的网络里依然能检测成功；回退来源在表格里标 `API`。
- **本地 `link:` 仓库**也会检测（标 `link`），但不提供一键更新（需手动 `git pull`）。
- **设置页 UI**（`settings.section`，order 45）：
  - 标题栏：DSH 发行版 / 检查时间 / 总项数 + 重新检测
  - 四个可点击统计卡（可更新 / 已最新 / 预发布 / 失败），点击即联动筛选两张表
  - npm 与 GitHub 两张原生 `<table>` 详表，版本与 commit 以 `旧 → 新` 合并显示
  - 每张表内独立的分段筛选器（默认只看**可更新**）、npm 按包名搜索、分区可折叠
  - 置顶状态横幅：检查进度条 / 更新进度（秒数 + pnpm `Progress:` 行）/ 成功失败结果
  - GitHub 可更新项的「更新」「停止」「重试」按钮
- **模型工具** `dsh_check_updates`：可直接让 Agent“检查有没有更新”。

## 关键设计：检查与更新都是后台任务

页面从不在一个请求里等待长任务——这正是动态版早期 `pnpm update` 跑 68s 后报 `Failed to fetch` 的原因。

- `check` / `update` 立即返回“已开始”，实际工作在 host 侧后台进行；
- 页面每 400ms 轮询 `progress` / `update-progress`，用 `resultAt`（报告时间戳）与 `result.seq`（更新结果序号）判断是否有新结果，再单独取一次 `report`；
- 因此离开设置页甚至关掉页面，后台任务照常完成，回来仍能看到结果。

浏览器与 host 之间只走一条本地 JSON 路由 `POST /dsh-update-checker/api`，动作：`check` / `progress` / `report` / `update` / `update-progress` / `cancel`。

## 检测口径

- npm 包“有更新” = npm 上存在比本机版本更高的已发布版本（`maxPublished > local`）。DSH 当前发行渠道是 `next`，所以多数包状态是**预发布**而非“已最新”。
- GitHub 包“有更新” = 远程默认分支最新 commit ≠ 已安装 commit。
- 结果缓存 5 分钟；「重新检测」强制绕过缓存。

## 一键更新的前提

更新执行的是 profile 目录下的 `pnpm update <包名>`，pnpm 需要访问 **github.com** 下载对应 commit。检测可以靠 GitHub API 绕过阻断，**更新不能**——`github.com:443` 不通时会失败并提示“网络恢复后重试”。更新完成后需重启 DSH 完全生效。

## 目录

| 文件 | 作用 |
| --- | --- |
| `index.js` | 安装形态的 host 半：本地 JSON 路由 + `dsh_check_updates` 工具 + 后台任务状态机 |
| `client.js` | 安装形态的浏览器半：`window.__ModuleLoader__.load(...)`，注册 `settings.section` |
| `lib/check.js` | 检测逻辑（两种形态共用口径）：profile 定位、npm 查询、GitHub commit 对比、版本比较 |
| `cordis.patch.yml` | `dsh.bundle.patch` 层：插入插件行 |
| `src/host.js` `src/client.js` | 动态形态的函数体快照（`cordis_define` 用） |
| `src/check-dsh-updates.cjs` | 独立脚本，可离线跑一遍检测 |
| `test/host-mount.test.js` | 用桩 ctx 真实挂载 host 半并跑通本地 API |

## 测试

```bash
pnpm test                        # node --test test/*.test.js（约 25s，会真的查询 npm 与 GitHub）
node src/check-dsh-updates.cjs   # 独立脚本，输出 JSON 报告
```

`test/host-mount.test.js` 用桩 `ctx` 挂载 `index.js`，断言：插件行导出、工具与路由注册、`check → progress → report` 全流程、非法包名被拒（`x && calc`）、disposer 可清理。这套测试不需要启动 `dsh web`。

## 依赖

- Node.js ≥ 18（`fetch`、`AbortSignal.timeout`）。
- GitHub 检测优先用 `git`，无 git 或连不上时回退 GitHub API。
- 一键更新需要 `pnpm`。
- host 半通过 `@deepseek-ai/dsh-tools` 注册模型工具；`link:` 安装时该包不在本包的解析路径上，`index.js` 会改从 profile 目录解析（拿到的是运行时同一个模块实例）。
