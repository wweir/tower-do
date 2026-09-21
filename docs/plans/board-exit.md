# Board 退出机制（已落地）

> **状态：已落地**（2026-09）。长期规则已回写：[CONTRACTS.md](../CONTRACTS.md)的
> "Finding contracts" / "Log compaction" / "Checkpoint digest"、
> [DECISIONS.md](../DECISIONS.md)的 "board exit: four layers, no single TTL"、
> [OPERATIONS.md](../OPERATIONS.md)的 "Log compaction (`tower_do action: gc`)"、
> [ARCHITECTURE.md](../ARCHITECTURE.md)的 compaction/digest 两节。本文件保留为
> 实现记录与验收清单，不再作为变更来源；下一次改动以主文档和测试 gate 为准。
>
> 被否决的写法（`retiredFindingIds`、`board.base.jsonl` 双文件、把
> `retainMessages` 当清理、按年龄自动关掉 open finding）不要再开。
>
> 落地对照：`state.ts`（常量/`deriveFindingState`/预算/`retainFindings`/
> `checkpointDigest`）、`index.ts`（talk 批量与 reason、dashboard 压力排序、
> digest 三处载荷、`action:"gc"`、`State:` 行）、`board.ts`（compact header +
> CAS/归档）、`test/finding-exit.ts`、`test/board-compact.ts`、
> `test/home-isolation.ts`、`test/smoke.ts`、`test/owner-guard.ts`、
> `test/identity-label.ts`。

## 问题

仓库没有独立的「全局 todo」面。持久化只有 per-project `board.jsonl`，三类记录 + 两类旁路状态：

| 面 | 今天的退出 | 实际效果 |
| --- | --- | --- |
| task | open 预算 50；非完成行 30min 接管；`remove` 只 append | 完成行与 upsert 历史在日志里无限长 |
| message | `retainMessages` 从**内存视图**丢掉全已读超出预算的行 | 不改文件；长命 session 全 ack 后新 session 读不到；未全读永驻视图 |
| finding | 无预算、无 TTL、无归档 | 只 append；`## Open findings` 按 `at DESC` 切 20 行，最老欠账永久看不见 |
| transcript checkpoint | `cloneBoard(currentView)` 整份写入 `pi-tower-do-board` | 实测单条快照峰值 321KB；finding 一堆，每次 compact 复制两遍 |
| `~/.pi/tower-do/<slug>/` | `stateDirFor` 只建不收；live sidecar 有 10min prune | 测试未隔离 HOME 会污染真实目录 |

`foldRetained()`（`index.ts`）只对 `messages` 做内存过滤副本。`readPersistedFinding()` 无 TTL。`DECISIONS.md` 的 `board-prune` 仍正确：**省略 completed 不会缩小文件**。

所以「堆积」是四件不同的事。任何把它们写成一个 TTL 的方案都会在另一层复发。

## 分层（先定边界）

```
创建 → 可归责 → 可处置 → 视图退休 → 日志有界 → transcript 有界
         │            │         │           │              └ Layer 4  CheckpointDigest
         │            │         │           └ Layer 3  显式 last-wins compact（改文件）
         │            │         └ Layer 2  retain*（纯内存，不改文件）
         │            └ Layer 1  状态机 + 预算（拒绝新欠账，不删旧欠账）
         └ liveness 只决定「该找谁」，永不决定「已解决」
```

- **Layer 2 不是清理。** `retainMessages` / 拟议的 `retainFindings` 只影响本次 fold 的显示副本。`tower_do_status` / inbox / reminder / widget / 写路径的 re-fold 都走它，所以退休行不回流到 LLM 窗口；`board.jsonl` 一字不动。
- **Layer 3 才是磁盘有界。** 默认不跑。显式、有名、有 CAS、有崩溃中点。
- **Layer 4 只止住新增 transcript。** 历史 session 文件不回收。

原则：

| | 禁止 |
| --- | --- |
| 显式退出：终态，或强制点上的显式处置 | 按年龄自动隐去 **actionable** finding |
| 关闭必带 `reason` | 无理由批量 `done` |
| 视图退休可反查（`view=all` / `findingId` / `inbox all`） | 视图丢掉且无处可读 |
| 日志不周期 rewrite | 定时删 `board.jsonl` / 用户目录 |
| 上限单一来源（`state.ts` 常量） | 各处字面量 |
| digest 每个字段有由**单一定义常量**推导的上界 | 任何随历史长度增长的 checkpoint 字段 |

## Layer 1 — finding 生命周期与预算

### 状态机

```
file → open
open ── claim(owner=self|explicit) ──→ accepted
open|accepted ── snooze(until ≤ now+30d, reason 必填) ──→ snoozed ── 到期 ──→ open
accepted ── close(done|rejected, reason 必填) ──→ done | rejected
```

`FINDING_STATUSES` 增 `snoozed`。旧日志无新字段：`owner`/`reason`/`snoozeUntil` 缺省合法，`readPersistedFinding` 不把它们打成 `skipped`。

派生（纯函数 `deriveFindingState(finding, now, liveOwners)`，不写入）：

| 派生态 | 定义 | 默认视图 |
| --- | --- | --- |
| `actionable` | `open`，或到期 `snoozed`，或 `accepted` 但 owner 不在 live 集合 | 列出 |
| `claimed` | `accepted` 且 owner 有 fresh sidecar | 列出 |
| `snoozed` | `snoozed` 且 `snoozeUntil > now` | 折叠为计数；`view=all` 列出 |
| `closed` | `done` \| `rejected` | 宽限 7d 内可见计数；其后视图退休 |

liveness 只把 `accepted` 打回 `actionable`（可被接管）。提出者 session 退出 **不得** 把 finding 标成关闭。

### 预算（堵住「免费延期」）

`MAX_TOWER_DO_OPEN_FINDINGS = 50`，与 task 预算分开。

**计费对象 = 全部非 closed finding**（`open` + `accepted` + `snoozed`，无论是否到期）。延期与声称处理都占名额；只有 `done`/`rejected` 释放。于是非 closed ≤ 50 是结构保证，Layer 4 的 findings 数组才真有上界。

超预算时 **新建** `action=finding` 被拒，错误点名最老的若干条（按待办压力，不是最新 20 条），并给出批量 remed。不拦 `send` / `inbox` / `tower_do`。

另：仍活着的 owner，其 `accepted` 超过 `FINDING_CLOSE_GRACE_MS = 7d` 时，该 owner **新建** finding 同样被拒，直到 `done|rejected|snooze`。owner 已死则回落 `actionable`，由预算逼 triage。

### 归责与批量

- `status=accepted` 且未给 `owner` ⇒ `owner := caller`。
- 接管与 task 同构：同一 sidecar 心跳；adopt 与改内容不可同一写。判定阈值见 Layer 1b，不复用 30min presence。
- `findingIds: string[]`（≤ 50，去重）+ 单个 `status` + `reason` / `snoozeUntil`；与 `findingId` 互斥。每条 id 仍 append 一条 LWW 事件，同一 `withFileMutationQueue`。`done|rejected|snoozed` 时 `reason` 必填（单行 ≤ `MAX_FINDING_REASON_CHARS = 256`）。
- finding **不**进入 `tower_do` 全量替换。

### 视图排序

`## Open findings` 停止 `at DESC` 切 20。按待办压力：超期 `actionable` → 普通 `actionable` → `claimed` → 到期将至的 `snoozed`。头行披露四类计数。截断必须说「最老的在后面」，并指向 `view=all` / `findingId`。

## Layer 1b — task / message 语义修正（仍属「谁该动」，不是删文件）

**task 接管阈值拆开。** `OWNER_TAKEOVER_MS`（30min）只服务 presence / idle 显示。接管改用 `TASK_CLAIM_STALE_MS = 6h`，且 `lastSeen` 是 **该 owner 在该 task key 上的事件活动**（`staleTaskClaims` 按 `by + taskKey` 取最大 `at`；活动条目不带 `dependsOn`/`blockedBy` 信息，依赖编辑算作被依赖行自身的更新），否则退回 `task.updatedAt`。全局「刚发过一条无关消息」不再给名下所有陈旧 task 免疫。完成行仍不可被 peer 丢掉。

**message 视图退休加一条年龄阀，仍不改文件。** 保留全已读超出 `MESSAGE_RETENTION` 的退休。未全读超过 `MESSAGE_PENDING_RETIRE_MS = 14d` 的，从默认 inbox/dashboard 移入「retired-in-view」，披露条数。`inbox all`（或等价开关）读退役区；退役 id 集合每次 fold **确定性重算**，只存在于内存与本次输出，**不进 checkpoint**。孤儿广播仍按现契约退休。

## Layer 2 — 视图退休（重申）

`retainFindings(findings, now, live)`：

- 永不丢非 closed 行（预算已经把它们卡在 50）。
- closed 超过 7d：默认视图移除，`view=all` 列出，`findingId` 走 folded 行（compact 之前 fold 仍持有全部 LWW finding）。
- 默认视图脚注 `… N closed finding(s) retired beyond 7d — view=all or findingId`。

`retainMessages` 维持「全已读才按预算裁」+ 新增 14d 未读视图退休。测试继续放 `test/presence-retention.ts`；文档禁止再把它写成 GC。

## Layer 3 — 日志有界：单文件 last-wins compact

### 为什么不用 `board.base.jsonl`

`fold()`（`board.ts`）对 `board.jsonl` **每个**有效 task upsert/remove 做 `revision += 1`，不读任何旁路文件。若「基线事件也参与 fold、同时 revision 因压缩不变」，基线已写、主日志未裁时会重复应用并重复计数；压缩后行数变少会让 `baseRevision` 对不上。双文件方案与现行 revision 不自洽，否决。

### 权威规则

Compact 是一次 **live 日志的 last-wins 重写**，带一条显式逻辑 revision，仍只读一个文件。

`board.jsonl` 经 compact 后的形状：

```
{kind:"compact", revision:<R>, at, by, sourceSha256, skipped, snapshotLines, counts}
{kind:"task", op:"upsert", key, task, by, at}   × 每条仍在 folded view 里的 task（含 completed）
{kind:"message", message, by, at}               × 每条仍在 folded view 里的 message
{kind:"finding", finding, by, at}               × 每条仍在 folded view 里的 finding
… 此后的新 append 与今天完全一样
```

`fold()`：

1. 读到 `kind:"compact"`：用其 `tasks/messages/findings` **不在这里**——compact 行只定 `revision = compact.revision` 与元数据；随后的 snapshot 事件按 LWW 填 map，**不** `revision += 1`。
2. compact 行之后、且 `at > compact.at`（或文件偏移在 snapshot 块之后）的普通事件：行为与今天相同，task 事件继续 `revision += 1`。
3. 无 compact 行：与今天完全相同（旧日志零迁移）。

实现上 snapshot 块用「compact 行内的 `snapshotLines` 计数」或「直到第一条 `at > compact.at` 的非 snapshot 标记」界定；测试钉死：**compact 当时的 `view.revision === R`，compact 之后未发生新 task 事件时 `fold().revision === R`。** 这是 `baseRevision` 不误拒的那条契约。

**compact 保留 folded view 的全部实体**（含 completed task、closed finding、未视图退休的 message）。它消灭的是同 key/id 的历史 upsert/ack，不是实体个数。实体个数由 Layer 1 预算 + Layer 2 视图退休约束；completed task 行继续按既有容量决策无界（收据 / `dependsOn`）。

可选：compact 前把原文件 copy 到 `archive/board-rev<R>-<utc>.jsonl`。`fold()` **永不**读 archive。archive 只给人工审计和 `findingId` 的第三级回落。

### 并发与崩溃（目录租约 + 硬链接 CAS + rename 窗口恢复）

`withFileMutationQueue` 只是进程内链；跨进程由 **`<board>.lock` 目录租约**负责（持有者 token 文件 + 心跳 mtime，只有心跳停止的 token 会被收割）。`append` 与 `compact` 都取该租约。compact 的实际顺序：

1. 取租约，读 live 并记录 `sourceSha256`，`fold()`。
2. 写 `board.jsonl.tmp`（compact 行 + last-wins 行），`fsync`。
3. 对旧 inode 做 hard `link` → `<board>.prev-<rand>`，**经该链接再读一遍**校验 CAS（检查的字节就是将被替换的字节）。
4. CAS 通过后写 `archive/…`（中止则清理未见 swap 的 archive），随后在 `rename` 前校验 **路径仍是被保留的 inode**（`stat(this.file).ino === stat(prev).ino`）：peer 在窗口内 compact（换掉了新 inode）时必须中止而非静默覆盖；确认后 `rename(tmp, board.jsonl)`。
5. rename 后**再证明一次租约**：
   - 仍独占 ⇒ 删掉 `.prev-*` 链接，成功返回；
   - 被偷（持有者在窗口内被暂停超过 `STALE_LOCK_MS`）⇒ **fail loud**。若形状可证明（live 仍是本次 compaction 加追加、证据文件是 `raw` 加追加），重新取租约并 CAS 写回 `content + P + W`（P 在 W 前，保持真实时序的 LWW）；不可证明（例如 peer 在窗口内自己 compact 了）则保留 `.prev-*` 作为证据并在错误信息里给出路径。**绝不盲目回滚**——回滚可能覆盖新持有者在 rename 之后的写入。

崩溃中点（任一步中止）：live 文件都不变（除 rename 之后），`.prev-*` / `.tmp` 只可能作为残留物存在，不影响 fold。禁止「先 truncate 再写」；禁止周期自动跑。

授权：`tower_do` 增加 `action: "gc"`，仅 `as: "tower"`（或调用方身份本就是 `tower`）。`tower_do_status` 在行数 ≥ 10k 或体积 ≥ 1MB 或 `skipped > 0` 时提示这条命令，不自动执行。

**activity / stale-owner：** compact 丢掉中间 upsert，`rawTail` 变短。快照为每个 task 事件保留该 owner 在该 key 上的真实最后活动时间（`taskClock`），为每个 finding 保留最后一条事件的 `by`/`at`（`findingActor`），因此 gc 不会把 owner 的活动时钟重置或把 peer 的 finding 状态变更记到原始 filer 头上。

**skipped：** `skipped > 0` 时默认拒绝 compact（否则静默丢掉 fold 读不懂的行）。调用方必须先处理或显式 `dropSkipped: true`（仍只允许 tower，结果写入 compact 元数据）。

**`rawLines()`：** 仍是 live 文件。compact 后不再含历史 upsert；需要审计走 archive。

## Layer 4 — transcript：有界 digest

替换三处 `cloneBoard(currentView)` 载荷（`session_compact` 的 `appendEntry` + steer `details`，`before_agent_start` 的 `details`）。reminder 的 **文本** 仍由 `formatBoardReminder` 从磁盘 re-fold 的 view 生成；进 transcript 的 structured payload 改为 digest。

```
CheckpointDigest
  schemaVersion, revision                          // O(1)
  counts: {
    tasks:    { byStatus, open }                   // O(1)
    findings: { actionable, claimed, snoozed, closed }  // O(1)，只有计数
    unread: number
  }
  openTasks: [{key, status, owner, subject}]       // ≤ MAX_TOWER_DO_OPEN_TASKS
  findings:  [{id, severity, kind, title, owner, state}]
                                                   // 非 closed，≤ MAX_TOWER_DO_OPEN_FINDINGS
```

不变量（写进 CONTRACTS，当作设计规则）：**digest 任一字段体积随 board 历史增长即为错误。** 禁止 `retiredFindingIds`、禁止 messages 数组、禁止 completed task 行。

新 customType `pi-tower-do-board-digest`。`latestBoardCheckpoint` 同时接受旧 `pi-tower-do-board` 与 digest，取最新。旧快照仍可读，所以投影不回收历史。

`restore()` 在 `board.jsonl` 缺失、只剩 digest 时：**禁止**再 `revision: 0` 伪装成可写空板。视图必须打印 board 路径不存在、digest rev N、完整内容不可用；digest 的 `revision` 只用于显示，写路径仍把缺文件当空板（与今天「缺文件 = 空板」一致），避免用幽灵 `baseRevision` 去过 gate。

磁盘缺失时的 `findingId`：不区分「已退休 / 未知」——无盘无法有据区分。文案：`该 id 不在 checkpoint 中（checkpoint 只携带非 closed finding 的标题，不含正文）；board 文件 <path> 不存在`。有盘时：fold → live `rawLines` → 可选 archive。

## Layer C — 状态目录（不删用户数据）

1. **测试污染是 bug。** `test/view-layers.ts` 等未设 `HOME=mkdtemp` 的用例按 `test/smoke.ts` 隔离；加静态断言：除白名单外测试文件必须改 HOME。不是 GC。
2. **live sidecar** 维持 `LIVE_PRUNE_MS`。`gc` 可顺带 prune 本项目 `live/`。永不自动 `rm` `board.jsonl` 或整个 slug 目录。
3. `tower_do_status` 增加 `state: <slug> · log N lines / X KB · compact rev M`（无 compact 则省略最后一项）。

## 常量

全部定义在 `state.ts`，schema 走既有 `transportLimit` 派生。

| 常量 | 值 | 作用层 |
| --- | --- | --- |
| `MAX_TOWER_DO_OPEN_FINDINGS` | 50 | L1 预算 / L4 数组上界 |
| `FINDING_CLOSE_GRACE_MS` | 7d | L1 关闭义务 / L2 closed 视图退休 |
| `FINDING_SNOOZE_MAX_MS` | 30d | L1 snooze 上限；到期回流 `open` |
| `MAX_FINDING_REASON_CHARS` | 256 | 关闭/延期理由 |
| `MESSAGE_PENDING_RETIRE_MS` | 14d | L2 未读视图退休 |
| `TASK_CLAIM_STALE_MS` | 6h | L1b 接管，与 30min presence 分离 |
| `BOARD_COMPACT_HINT_LINES` | 10_000 | L3 提示阈值，不是自动触发 |
| `BOARD_COMPACT_HINT_BYTES` | 1 MiB | 同上 |
| `TOWER_DO_BOARD_DIGEST_TYPE` | `pi-tower-do-board-digest` | L4 |

`MESSAGE_RETENTION = 50`、`MAX_TOWER_DO_OPEN_TASKS = 50` 不变。

## 明确拒绝

| 方案 | 理由 |
| --- | --- |
| 按年龄自动关闭/隐去 open finding | 把「没人处置」做成「不必处置」；WingGate 的 high bug 会被封存 |
| 提出者离线 ⇒ finding 已解决 | 存活 ≠ 问题消失 |
| `retiredFindingIds` 进 digest | O(历史)；checkpoint 不是索引 |
| snooze 不计预算 | 一次免费操作可把 500 条全部延期，digest 再次无界 |
| 把 `retainMessages` 写成全局清理 | 它只返回内存过滤副本 |
| `board.base.jsonl` + 主日志双文件且「revision 不变」 | 与 `fold()` 按行计数冲突，崩溃中点会重复计数 |
| 周期自动 compact / 删目录 | 审计不可事后核验；必须显式 `gc` |
| finding 进入 `tower_do` 全量替换 | 把 task 契约扩散到逐条 LWW 记录 |
| 只加渲染上限 | 已失败：最老欠账永久不可见 |
| 把 `OWNER_TAKEOVER_MS` 再调大 | 错在全局 lastSeen，不在 30min 本身 |
| compact 后仍 `revision: 0` 兜底 | 要么不可写，要么用幽灵 rev 打 gate |

## 测试 gate（落地时新增，计入 CONTRACTS 清单）

`test/finding-exit.ts`（纯逻辑）+ compact 的磁盘用例（可放 `test/board-compact.ts`，需要临时文件）：

- 50 条 snoozed（未到期）+ 1 条新建 ⇒ 拒绝（snooze 计费）。
- 200 条 open：`retainFindings` 一条不丢；新建第 51 条被拒并点名最老。
- claim 默认 owner；`accepted` + 无 live ⇒ 派生态 `actionable`。
- close/snooze 缺 reason 被拒；`findingIds` 批量 = 逐条 LWW 且顺序稳定。
- 旧 finding 行（无 `owner`）fold 不进 `skipped`。
- 1000 closed finding + 1000 completed task：digest JSON 字节数与 10 条时相同；digest 顶层与 `counts` 内不得再有其它数组字段。
- `restore` 仅 digest：披露不可写全量，不产出可当 `baseRevision` 用的幽灵板。
- `staleTaskClaims`：无关全局活动不免疫；同 task 活动或 `updatedAt` 才算。
- compact：`fold().revision` 等于 compact 前；CAS 冲突中止且 live 不变；rename 前崩溃 live 不变；`skipped > 0` 默认拒绝。
- `inbox all` 能读到视图退休的消息；默认 inbox 读不到。

HOME 隔离断言放现有测试文件，不算新套件。

## 落地顺序

1. 常量 + `deriveFindingState` / 预算检查 / `retainFindings` + `test/finding-exit.ts`。
2. `tower_do_talk` 字段（`owner`/`reason`/`snoozeUntil`/`findingIds`/`inbox all`）与 dashboard 排序/计数。
3. `staleTaskClaims` 判定改造 + 既有 `test/owner-guard.ts`。
4. `CheckpointDigest` 替换三处 clone；`latestBoardCheckpoint` 双类型；`restore` 披露。
5. `fold()` 识别 `kind:"compact"` + `action: "gc"` CAS；`test/board-compact.ts`。
6. 测试 HOME 隔离；`tower_do_status` 的 `state:` 行。
7. 回写 CONTRACTS / DECISIONS / OPERATIONS / ARCHITECTURE（digest 与 compact 各一段），删除本计划或改成「已落地」指针。

## 仍需拍板（默认按本文）

1. **非 closed finding 满 50 拒绝新建** — 接受。替代（只排序不拒绝）等于维持现状。
2. **7d / 14d / 6h / 30d** — 语义写进 CONTRACTS，不是调参旋钮。
3. **`gc` 仅 `tower`** — 与「压缩完成板」同一授权面；live owner 不得改写他人收据所在的日志。
