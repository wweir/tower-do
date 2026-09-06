# tower-do — 共享多 Agent WIP 看板（pi 扩展）

> 一个 todo 风格的 pi 扩展，融入了 **Kimi Tower 多 worker 编排**的协调设计，让多个 agent（会话/子代理）共享"正在进行的事"以及与任务绑定的沟通状态。

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

pi 启动即自动发现；已有会话用 `/reload` 热加载。运行时依赖 `typebox` 与 `@earendil-works/*` 由 pi 环境提供（peerDependencies，无需手动安装）。

## 工具

| 工具 | 作用 |
| --- | --- |
| `tower_do` | 共享看板的一键原子更新：plan / 认领（owner+in_progress）/ 完成 / 阻塞（blocked+blockedBy）。支持 `baseRevision` 防踩踏 |
| `tower_do_talk` | 跨 agent 沟通：`send`（给已知 owner 或 `all` 发消息，禁自发）、`inbox`、`finding`（结构化越界上报/状态更新） |
| `tower_do_status` | 共享仪表盘：所有人的 WIP（owner/依赖/scope/阻塞原因）、给我的消息、未决 finding、活动尾 |

身份解析：`as` 参数 > 项目配置 `identity` > 会话名 > 会话 id。为子代理代记时传子代理 id（如 `as: "coder-1"`）。

## 与 Kimi Tower 的对应（设计映射）

| Kimi Tower 机制 | tower-do 落地 |
| --- | --- |
| 共享黑板（file-as-state） | `<project>/.pi/tower-do/board.jsonl`，append-only JSONL，折叠成当前视图；任何能读文件的会话/子代理都能看到同一份 WIP |
| 角色分工（worker 只动自己的 mission） | 任务可带 `owner`；只有 owner 或保留身份 `tower` 能改它的 status/scope（越权直接报错） |
| mission scope | 任务可带 `scope`（文件 glob），全可见，仅 owner/tower 可扩 |
| 协商（站内信/finding） | `tower_do_talk`：收件人必须是已知 owner 或 `all`、禁自发；越界发现走 finding 而不是偷偷改 |
| 确定性门禁（revision 工具读数） | 看板 `revision` 由文件事件数推导（写入结果 = 重折叠结果），`baseRevision` 陈旧即拒——绝不静默覆盖同伴的更新 |

## 多 agent 用法

**同一 pi 会话 + 子代理（典型）**：父代理 `tower_do` 拆任务、`owner` 认领；把 `tower_do_status` 输出的看板路径给子代理读（file-as-state），子代理回传结果，父代理 `tower_do` 收口（或传 `as` 代记）。依赖关系用 `dependsOn`（未完成的依赖会显示为阻塞原因）。

**多个 pi 会话共享同一项目**：两边自动读写同一个 `<project>/.pi/tower-do/board.jsonl`；一个会话发消息，另一个 `inbox` 可读——这就是跨 agent 消息的落地形态。

## 作用域：什么算一个「项目」

看板按**项目**共享，不是按字面工作目录。每个会话的 `cwd` 会先向上解析到**最近的 git 根**（含 `.git` 目录的仓库，或含 `gitdir:` 文件的 worktree/submodule）；**若一直找不到 git 边界，则该目录本身就是项目边界**。

| 场景 | 效果 |
| --- | --- |
| `cd /repo` 与 `cd /repo/src` 两个会话 | 共享同一块板（同 git 根） |
| 同 repo 根会话 + 任意深子目录会话 | 共享（都锚定到 repo 根） |
| 两个互不相干的非 git 目录 | 各自独立（目录即边界） |
| 嵌套 git repo（子目录自带 `.git`） | 各自按自己的根，互不越界 |
| git worktree（`.git` 是文件） | 该 worktree 根即边界 |

配置 `config.json` 同样锚定到项目根：`identity` 是**项目级**的，同一项目不同会话共享同一身份配置。

## 配置（可选）

`<project>/.pi/tower-do/config.json`：

```json
{ "identity": "team-orchestrator", "reminderInterval": 3, "collapsedTaskLimit": 3, "activityTail": 8, "messageRetention": 50 }
```

- `reminderInterval`: 每 N 次 LLM 调用注入一次看板对账提醒（0=关）
- `identity`: 固定本会话身份（否则取会话名/会话 id）
- `collapsedTaskLimit`: widget 未完成任务最多显示行数（超出折叠为 `… +N more`）
- `activityTail`: `tower_do_status` 活动尾显示的事件行数
- `messageRetention`: 消息保留预算——**全员已读**的旧消息超过该预算即从所有读视图退出（默认 50，`0` = 全保留，旧行为）；未读/部分已读的消息永不退出

## 设计要点与约定

- **写路径全部在 `withFileMutationQueue` 内 re-fold**：baseRevision 校验与 diff 都基于锁内最新视图，杜绝"先读后写"竞态（与 Kimi Tower store 的可验证性同一哲学）。
- 每个变更都是追加事件（`{kind,task|message|finding,...}`）；revision = 累计任务事件数，**write 返回的 revision 与重折叠完全一致**。无任何字段变化的 `tower_do` 调用（no-op）回执明确提示 `board unchanged`、不追加事件、且**保留原 `updatedAt` 不漂移**。
- **删除有守卫 + 全量替换**：`tower_do` 是整板替换——每个省略的 key 都被删除。删除只允许删自己的或无人认领的任务；删别人的 owned 任务会被 owner 守卫拒绝。依赖校验基于**写后图**：幸存任务不能依赖本写中被删的任务（可同写先 `dependsOn: []` 清依赖再删目标），也不能依赖板上不存在或本写未提供的任务。owned 任务的 status/owner/scope 只有 owner/tower 能改（subject/description 非保护字段，整板 LWW 重写时允许携带）。
- 消息 body ≤ 32KB；多行报告用指针式引用，保持上下文精简。
- **消息带已读回执**：`readBy` 记录谁读过；`tower_do_talk inbox` 阅读即自动 ack（追加同 id 事件，LWW 折叠不重复）。广播的**发送者不算读者**（自发消息不进自己 inbox），因此其余 owner 都读过后广播即可退役。广播发送时会**快照当时的 owner 列表为 `audience`**：之后新加入的 owner 不是广播受众，不会让旧广播永不退役。**历史日志的 backward-compat**：无 audience 字段的旧广播在 fold 时从重放点的 owner 表**回填 audience**（取发送时刻在场 owner，sender 除外；owner 转移不泄漏旧 owner；后续 ack 重放不会拓宽已回填的 audience）。
- **无法投递的消息自动退役**：指名消息若收件人已离开板（板重建/清空后无人能读）视为已读可退役；**广播的 audience 成员若已全部离场**（整轮测试/协调结束，板在全新 owner 下重建）同样视为可退役——已结束的广播轮次不会因无人读而永久卡住保留预算。孤儿消息不会无限占用折叠视图。
- **历史消息退出机制**：只读视图（status/inbox/reminder/widget）统一套 `retainMessages`——**未读永不退出**，仅当全员已读的消息数超出 `messageRetention` 预算时，最旧的已读历史退出视图。磁盘 append-only 事件日志保留（审计），fold 输出不再膨胀。
- **在场（presence）零写入派生**：`tower_do_status` 的 `Who is around` 段从活动日志按 `by` 聚合最近时间得出（纯读，绝不把读操作者标成活跃），只列出**拥有未完成任务的人**或**1 小时内活动过的人**，其余历史身份折叠为计数。状态区分三种：**活跃**（刚动过）、**`⚠ idle`**（曾活动但超过 10 分钟无动作——协调者可消息或回收）、**(not started)**（新分配、从未在板上活动——不是停滞，不误报 idle）。tower_do 写回执也会尾注真实 idle owners。`Recent activity` 段渲染为紧凑人类行（`who · time · glyph detail`），消息 ack 显示为 `👁 read` 而非重发。相邻事件间隔超过 30 分钟时渲染 `── session break ──` 分隔线，区分"同一次会话连续操作"与"隔了多次会话"；头部另加一行 `last updated N ago by X`（从活动尾纯读派生），revision 本身单调但不带活跃度——一眼判断板是否停滞。
- 完成标准：任务 completed 只应在实现+验证成功之后；等依赖/同伴用 `blocked` + `blockedBy`，不要挂着不动。
- 内存态只作 widget/提醒缓存，磁盘文件是唯一权威；工作区被清理后从最近会话检查点（custom entry）恢复兜底。

## 验证

```bash
cd <repo>/extensions/tower-do   # 或已 clone 的仓库根
tsc --noEmit -p tsconfig.json   # 权威类型检查（含 strict + noUnused）
bun run test/smoke.ts                # 冒烟：ownership/删除越权、悬空依赖、stale revision、消息/finding、跨实例持久化、三工具端到端
bun run test/owner-guard.ts          # full-field 属主守卫回归（10 项）
bun run test/presence-retention.ts   # 已读回执 + 历史退出 + 在场派生 + feed 渲染/会话分隔 + 孤儿/audience 退役回归（34 项）
```

冒烟覆盖：规划持久化、依赖阻塞/解锁、`tower` 绕过与任意删除、owner-only 变更/删除强制、悬空依赖拦截、同写删依赖目标拒绝/清依赖后放行、stale baseRevision 拒绝、站内信投递与收件箱、tower 合法收件人、禁自发、字段单行约束、非法 status 过滤报错、finding 上报与仪表盘可见、跨子目录/嵌套 repo/worktree 项目作用域、第二会话读到同一看板。

## 文件

```
├── index.ts     # 扩展入口：3 工具 + widget + 提醒 + 生命周期
├── state.ts     # 纯 schema/校验/折叠/快照/已读保留/在场派生（参考 todo 扩展的 state.ts 风格）
├── board.ts     # 磁盘层：append-only JSONL（file-as-state）+ 配置
├── test/smoke.ts
├── test/owner-guard.ts
├── test/presence-retention.ts
├── tsconfig.json  # 仅供 typecheck
└── README.md
```

参考资料：Kimi Tower 多 worker 协调设计（Tower 官方博客/文档）与扩展参考实现 <https://github.com/99percentpeople/pi-extensions/blob/master/extensions/todo/index.ts>。
