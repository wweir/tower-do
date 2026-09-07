# tower-do — 共享多 Agent 任务看板（pi 扩展）

> 一个 todo 风格的 pi 扩展，融入了 **Kimi Tower 多 worker 编排**的协调设计，让多个 agent（会话/子代理）共享"正在进行的事"以及与任务绑定的沟通状态。

[![npm version](https://img.shields.io/npm/v/tower-do.svg)](https://www.npmjs.com/package/tower-do)
[![Pi gallery](https://img.shields.io/badge/Pi-gallery-7c3aed)](https://pi.dev/packages/tower-do)
[![GitHub](https://img.shields.io/badge/GitHub-wweir%2Ftower--do-181717?logo=github)](https://github.com/wweir/tower-do)
[![License: MPL-2.0](https://img.shields.io/badge/license-MPL--2.0-orange.svg)](LICENSE)

[English README](./README.md)

## 功能

面向并行 pi agent 的共享任务看板：计划 / 认领 / 完成 / 阻塞任务（带 owner 与依赖）、跨 agent 消息与 finding、全局状态仪表盘。**冲突感知**：完成任务时带 `changedFiles`（你实际改过的文件的交付回执）+ 声明 `scope`（文件 glob 边界）后，`tower_do_status` 会派生两类**建议性告警**——**overlap**（某个进行中/待办任务的 scope 命中了刚完成任务的回执文件，"你打算动的文件别人刚改过"）与 **collision**（两个进行中任务的 scope 相交）。告警只提示不拦截，通过消息协调或调整 scope 解决。编辑器上方 widget 另有 git 段（工作区 dirty vs 本会话实际改过的文件数），见 [docs/PRODUCT.md](docs/PRODUCT.md)。

三个工具：

| 工具 | 用途 |
| --- | --- |
| `tower_do` | 一次性原子更新看板：计划 / 认领（`owner` + `in_progress`）/ 完成（带 `changedFiles` 回执）/ 阻塞（`blocked` + `blockedBy`）。`baseRevision` 防覆盖 |
| `tower_do_talk` | 跨 agent 消息：`send`（已知 owner 或 `all`；禁止自发）/ `inbox` / `finding`（结构化越界上报） |
| `tower_do_status` | 共享仪表盘：所有人的进行中工作（owner / deps / scope / changedFiles / 阻塞原因）、**scope 冲突**、消息、open findings、活动与在场状态 |

## 安装

**方式一：从 npm 安装（推荐）**

```bash
pi install npm:tower-do
```

**方式二：从 git 安装**

```bash
pi install git:https://github.com/wweir/tower-do.git@main
```

**方式三：手动放到全局扩展目录**

```bash
mkdir -p ~/.pi/agent/extensions && cp -r tower-do ~/.pi/agent/extensions/
```

pi 启动时自动发现扩展；已开会话用 `/reload` 加载。运行依赖（`typebox`、`@earendil-works/*`）由 pi 环境提供（peerDependencies，无需手动安装）。

## 发布

在 `main` 上打 `vX.Y.Z` 标签即触发 CI 运行编译 + 测试门禁，自动发布到 npm 并创建 GitHub Release（见 `.github/workflows/release.yml` 与 [docs/OPERATIONS.md](docs/OPERATIONS.md)）。标签须与 `package.json` 的 `version` 一致。

## 快速上手

**单个 pi 会话 + 子代理（典型用法）**：父会话在板上规划并认领 owner；把 `tower_do_status` 打印的看板路径交给子代理（file-as-state）；子代理回报结果；父会话收口。**多个 pi 会话共享同一项目**：两边自动读写同一个 `<project>/.pi/tower-do/board.jsonl` —— 发消息、对方 `inbox` 读取，即跨 agent 通讯。

身份解析：`as` 参数 > 项目配置 `identity` > 会话名 > 会话 id。代子代理记录工作时传它的 id（如 `as: "coder-1"`）。

## 配置

仅一个可选键 —— `<project>/.pi/tower-do/config.json`。无环境变量。

```json
{ "identity": "team-orchestrator" }
```

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `identity` | 会话名/会话 id | 钉住本会话的看板身份（项目级）；不得使用保留的编排者身份 `tower` |

配置面就这些。文件缺失 = 默认值；未知键忽略（向前兼容）；文件损坏或 `identity` 非法在会话启动时大声报错——绝不静默回退，静默重置身份会破坏多 agent 场景下的 owner 匹配。该文件无 secret，可提交共享团队设置；只需 gitignore `board.jsonl`。详见 [docs/OPERATIONS.md](docs/OPERATIONS.md)。

## 架构

三层，依赖方向严格单向（上层依赖下层，从不反向）：

```text
Pi 会话 / 子代理（多个，同一项目）
   │  tower_do · tower_do_talk · tower_do_status（+ widget、提醒）
   ▼
index.ts   扩展层 —— 工具参数与提示词契约、TUI widget、看板对账提醒、会话生命周期
   ▼
state.ts   纯逻辑核心 —— schema + 校验（全字段 owner 门禁、baseRevision 防覆盖门禁）、
           事件折叠、只读派生（在场 / 阻塞 / scope 冲突 / 消息保留）；无 I/O
   ▼
board.ts   磁盘层 —— 追加式 JSONL 事件日志；每次读取都从磁盘重新折叠，写入方追加单行事件
   ▼
<project>/.pi/tower-do/board.jsonl   唯一事实源（file-as-state，所有会话共享；需 gitignore）
```

写路径：工具参数 → 校验 + revision 门禁 → 追加事件 → 折叠 → 视图。读路径：重新折叠事件得到视图，其余全部只读派生——除日志外没有可变状态文件。完整数据流与派生规则见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/PRODUCT.md](docs/PRODUCT.md) | 产品范围与高层体验 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 系统边界、事件日志与折叠、只读派生（在场 / 阻塞 / scope 冲突 / 消息保留） |
| [docs/CONTRACTS.md](docs/CONTRACTS.md) | 任务模型不变量（含 `changedFiles` 回执与 scope 冲突契约）、owner 门禁、revision 门禁、测试 gate |
| [docs/DECISIONS.md](docs/DECISIONS.md) | 关键决策：共享"边界事实"而非 diff（P0/P1）、widget git 段、file-as-state、全字段 owner 门禁、scope 仅建议 |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | 安装、配置、运行、排障 |
| [English README](./README.md) | English version |

## 文件结构

```text
├── index.ts     # 扩展入口：3 工具 + widget + 提醒 + 生命周期
├── state.ts     # 纯 schema/校验/折叠/只读派生（无 I/O）
├── board.ts     # 磁盘层：追加式 JSONL（file-as-state）+ 配置
├── git-count.ts # widget git 段的 dirty/session 文件数纯函数派生（无 I/O）
├── test/        # smoke + owner-guard + presence-retention + changed-files + scope-conflicts + config + git-count
├── docs/        # PRODUCT / ARCHITECTURE / CONTRACTS / DECISIONS / OPERATIONS
└── README.md
```

## 验证

```bash
bun install                          # devDeps —— 仅类型检查/测试用
bunx tsc --noEmit -p tsconfig.json   # strict + noUnused，零错误
bun run test/smoke.ts               # 端到端：3 工具、持久化、项目边界、changedFiles 磁盘往返
bun run test/config.ts              # 配置 fail-loud + 保留身份（11 用例）
bun run test/owner-guard.ts         # 全字段 owner 门禁（10 用例）
bun run test/presence-retention.ts  # 读回执 / 消息保留 / 在场派生（34 用例）
bun run test/changed-files.ts       # P0 交付回执不变量（10 用例）
bun run test/scope-conflicts.ts     # P1 glob 匹配 + 冲突派生（17 用例）
bun run test/git-count.ts           # widget git 段纯函数派生（24 用例）
```

各套件证明的内容见 [docs/CONTRACTS.md](docs/CONTRACTS.md)。

参考：Kimi Tower 多 worker 编排设计（官方 Tower blog/docs）与参考扩展实现
<https://github.com/99percentpeople/pi-extensions/blob/master/extensions/todo/index.ts>。
