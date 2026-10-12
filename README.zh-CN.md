# tower-do — 同项目共享看板 + 跨 session 消息（Pi 扩展）

> 一个 todo 风格的 Pi 扩展：同一项目里的每个 session 共享一块任务看板，并可以给项目里的其他 session 发消息。

[![npm version](https://img.shields.io/npm/v/tower-do.svg)](https://www.npmjs.com/package/tower-do)
[![Pi gallery](https://img.shields.io/badge/Pi-gallery-7c3aed)](https://pi.dev/packages/tower-do)
[![GitHub](https://img.shields.io/badge/GitHub-wweir%2Ftower--do-181717?logo=github)](https://github.com/wweir/tower-do)
[![License: MPL-2.0](https://img.shields.io/badge/license-MPL--2.0-orange.svg)](LICENSE)

[English README](./README.md)

## 两个功能

并行 coding agent 的问题出在协作，而不是写代码。tower-do 给同一项目里的每个 session 和 subagent 两样东西：

1. **共享 todo 看板。** 计划、认领、更新、完成、阻塞任务，带 owner 和依赖。所有 session 读写同一块看板——没有 daemon、没有数据库、没有服务端，只有每个项目一个文件。
2. **跨 session 消息。** 给另一个 session 发定向消息（或广播 `all`），并读取自己的收件箱。消息存在同一块看板上，对方下次查看就能看到，`tower_do_status` 也会显示未读数。

外加一行编辑器上方 widget（`TowerDo 3 open · 1 msg`）。

三个工具：

| 工具 | 用途 |
| --- | --- |
| `tower_do` | 一次原子看板更新。`tasks` 是 **upsert** 列表（新建或合并补丁），`remove` 显式删除。用 `owner` + `in_progress` 认领，`status: "completed"` 完成，`status: "blocked"` + `blockedBy` 阻塞。`baseRevision` 会拒绝过期写入，而不是覆盖他人。 |
| `tower_do_talk` | `send` 发定向消息（收件人须为 `all`、`tower`、当前 task owner，或近期有看板活动的身份；禁止发给自己）；`inbox` 列出并确认自己的消息。 |
| `tower_do_status` | 共享看板：全部未完成任务（按最近更新）、completed 行的键账目、发给你的消息、活动尾部。`taskKey` 返回单个任务详情；把它返回的 revision 作为 `baseRevision` 传回。 |

## 安装

**方式一 —— npm（推荐）**

```bash
pi install npm:tower-do
```

**方式二 —— git**

```bash
pi install git:https://github.com/wweir/tower-do.git@main
```

**方式三 —— 手动复制到全局扩展目录**

```bash
mkdir -p ~/.pi/agent/extensions && cp -r tower-do ~/.pi/agent/extensions/
```

Pi 启动时自动发现该扩展；已有 session 用 `/reload` 生效。

## 快速上手

**一个 session + subagent（典型）。** 父 session 在看板上计划任务并指定 owner；把 `tower_do_status` 返回的看板路径交给 subagent（file-as-state）；它们回报；父 session 收尾。

**多个 session、同一项目。** 双方读写同一个 `~/.pi/tower-do/<project>/board.jsonl`。用 `tower_do_talk` 发消息，对方在 `inbox` 里看到（widget / status 里也会显示未读数）。

**Upsert，不是重放。** 一次写入只列出它新建或改动的行——没提到的 key 保持原样，所以部分写入永远不会删掉别人的任务。删除要显式 `remove: ["key"]`。

身份解析：`as` 参数 > config `identity` > session name > session id。替 subagent 记录工作时传它的 id（例如 `as: "coder-1"`）。

## 配置

只有一个可选键——`~/.pi/agent/tower-do/config.json`（全局，对所有项目生效）。没有环境变量。

```json
{ "identity": "team-orchestrator" }
```

| key | 默认 | 含义 |
| --- | --- | --- |
| `identity` | session name/id | 固定本 session 的看板身份（全局，对所有项目生效）；不能是保留的编排者身份 `tower` |

## 工作原理

每个项目一个 append-only JSONL 文件（`~/.pi/tower-do/<project>/board.jsonl`）是唯一事实来源——状态与通信是同一份存储。每次读取都重新 fold；写入带单调 revision，因此对方的并发更新会被拒绝而不是被静默覆盖。系统边界、事件语义与派生读取见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/PRODUCT.md](docs/PRODUCT.md) | 产品范围与高层体验 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 系统边界、事件日志与 fold、源码布局 |
| [docs/CONTRACTS.md](docs/CONTRACTS.md) | 任务模型不变量、owner 守卫、消息契约、revision 门禁、测试门禁 |
| [docs/DECISIONS.md](docs/DECISIONS.md) | 为什么：file-as-state、upsert 写入、owner 守卫、单时钟接管 |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | 安装、配置、发布流程（tag → CI → npm）、排障 |

质量门禁：`bunx tsc --noEmit` 加上 [docs/CONTRACTS.md](docs/CONTRACTS.md) 里列出的测试套件，在每次 release tag 上由 CI 强制执行。

## License

MPL-2.0。
