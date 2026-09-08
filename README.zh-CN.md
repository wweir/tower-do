# tower-do — 共享多 Agent 任务看板（pi 扩展）

> 一个 todo 风格的 pi 扩展，融入了 **Kimi Tower 多 worker 编排**的协调设计，让多个 agent（会话/子代理）共享"正在进行的事"以及与任务绑定的沟通状态。

[![npm version](https://img.shields.io/npm/v/tower-do.svg)](https://www.npmjs.com/package/tower-do)
[![Pi gallery](https://img.shields.io/badge/Pi-gallery-7c3aed)](https://pi.dev/packages/tower-do)
[![GitHub](https://img.shields.io/badge/GitHub-wweir%2Ftower--do-181717?logo=github)](https://github.com/wweir/tower-do)
[![License: MPL-2.0](https://img.shields.io/badge/license-MPL--2.0-orange.svg)](LICENSE)

[English README](./README.md)

![tower-do 编辑器上方 widget：剩余工作进度（`TowerDo 6 open · 1 blocked`）、活跃 session 数、`mine/dirty` 文件段、带标注的未完成任务行](https://raw.githubusercontent.com/wweir/tower-do/main/docs/pi-tower-do.png)

## 解决什么问题

并行编码 agent 的瓶颈在协调而不在编码：互相覆盖文件、重做已完成的工作、不知道谁在做什么。tower-do 给项目里的每个 agent 一块共享看板来规划、认领、完成工作——并附带跨 agent 沟通的方式。

- **一块看板，多个 agent。** 计划、认领、完成、阻塞任务，带 owner 与依赖。每个会话和子代理读写同一块看板——无守护进程、无数据库，装上扩展即用。
- **完成带回执。** 任务完成时记录你实际改过的文件（`changedFiles`），接手下一个任务的人立刻知道刚动了哪些地方。
- **在工作现场沟通。** 给任务 owner 发定向消息（或广播全员），外加结构化 finding（bug / improve / vuln / idea）上报越界发现——路由到对的 agent，而不是淹没在聊天里。
- **冲突感知。** 仪表盘会提示：你任务的 scope 范围命中了同伴刚改过的文件，或两个进行中任务的 scope 相交——只是建议性告警，靠消息协调，不做拦截门禁。
- **谁在场。** 在场状态显示哪些 session 活跃、哪些空闲、哪些还挂着未完成任务却没了动静——协调者知道该 ping 谁，而不是盲 目重派。
- **一个说明现状的 widget。** 编辑器上方一行展示剩余工作（`TowerDo 2 open · 1 blocked`）、活跃 session 数、脏文件里哪些是你改的，以及带 owner 的未完成任务。

三个工具：

| 工具 | 用途 |
| --- | --- |
| `tower_do` | 一次性原子更新看板：计划 / 认领（`owner` + `in_progress`）/ 完成（带 `changedFiles` 回执）/ 阻塞（`blocked` + `blockedBy`）。`baseRevision` 防覆盖 |
| `tower_do_talk` | 跨 agent 消息：`send`（owner / 近期有活动的 identity / `all`；禁止自发）/ `inbox` / `finding`（结构化越界上报） |
| `tower_do_status` | 共享仪表盘：所有人的进行中工作（owner / deps / scope / changedFiles / 阻塞原因）、**scope 冲突**、消息、open findings、活动与在场状态；`taskKey` 返回单任务全字段详情 |

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

pi 启动时自动发现扩展；已开会话用 `/reload` 加载。

## 快速上手

**单个 pi 会话 + 子代理（典型用法）**：父会话在板上规划并认领 owner；把 `tower_do_status` 打印的看板路径交给子代理（file-as-state）；子代理回报结果；父会话收口。**多个 pi 会话共享同一项目**：两边自动读写同一个 `~/.pi/tower-do/<project>/board.jsonl` —— 发消息、对方 `inbox` 读取，即跨 agent 通讯。

身份解析：`as` 参数 > 项目配置 `identity` > 会话名 > 会话 id。代子代理记录工作时传它的 id（如 `as: "coder-1"`）。

## 配置

仅一个可选键 —— `~/.pi/tower-do/config.json`（全局，跨项目生效）。无环境变量。

```json
{ "identity": "team-orchestrator" }
```

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `identity` | 会话名/会话 id | 钉住本会话的看板身份（项目级）；不得使用保留的编排者身份 `tower` |

## 工作原理

每个项目一个追加式 JSONL 文件（`~/.pi/tower-do/<project>/board.jsonl`）是唯一事实源——状态与通信是同一份存储。每次读取都从日志重新折叠；写入携带单调递增的 revision，同伴的并发更新会被拒绝而不是被静默覆盖。系统边界、事件语义与只读派生见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/PRODUCT.md](docs/PRODUCT.md) | 产品范围与高层体验 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 系统边界、事件日志与折叠、源码布局、只读派生（在场 / 阻塞 / scope 冲突 / 消息保留） |
| [docs/CONTRACTS.md](docs/CONTRACTS.md) | 任务模型不变量（含 `changedFiles` 回执与 scope 冲突契约）、owner 门禁、revision 门禁、测试 gate |
| [docs/DECISIONS.md](docs/DECISIONS.md) | 关键决策：共享"边界事实"而非 diff（P0/P1）、widget 分段、file-as-state、全字段 owner 门禁、scope 仅建议 |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | 安装、配置、发布流程（tag → CI → npm）、排障 |
| [English README](./README.md) | English version |

质量门禁：`bunx tsc --noEmit` 加九个测试套件，在每次发版 tag 的 CI 上强制执行——清单与各套件证明的内容见 [docs/CONTRACTS.md](docs/CONTRACTS.md)。

参考：Kimi Tower 多 worker 编排设计（官方 Tower blog/docs）与参考扩展实现
<https://github.com/99percentpeople/pi-extensions/blob/master/extensions/todo/index.ts>。
