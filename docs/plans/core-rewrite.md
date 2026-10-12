# Plan — 只保留两个核心功能

> 短期计划文档。目标：只保留 (1) 同项目共享的 todolist，(2) 同项目跨 session
> 发消息。完成后长期规则回写 PRODUCT/ARCHITECTURE/CONTRACTS，删除本文。

## 方式：减法，不是从零重写

调研发现：**磁盘事件格式已经是干净的 per-entity 增删日志**
（`BoardEvent = {kind:"task", op:"upsert"|"remove", key, task, by, at}`，一条事件一个变更）。
真正产生 bug 的是**调用侧语义**（`tower_do` 的 `tasks` 是"全量替换，省略即删除"）
与**附加功能带来的多时钟派生状态**。

因此正确且干净的做法是**保留已验证的存储核心（事件格式 + fold + 校验），
删掉附加功能，只改写入语义**——而不是把 fold/校验重写一遍再引入新 bug。

## 决策（已定）

- **D1 并发**：去写租约 / CAS / compaction / archive。`append` 用
  `open(O_APPEND)` + 单次 `write(2)`，进程内 `serialize` 保序；跨进程靠 O_APPEND
  原子性。日志按"实际变更"增长，fold 几百 KB 很便宜；未来 `gc` 是优化，不是正确性前提。
- **D2 消息**：只保留 pull（`inbox` + reminder）。去掉 push wake：它需要
  pending marker / branch 持久化 / 唤醒窗口才能不重复投递，复杂度不值。
- **D3 UI**：保留极简 widget（`◻ N open · ✉ M unread`）+ 一行 reminder；删 git 段与 `live N`。
- **D4 兼容**：完整兼容读现有 `board.jsonl`（忽略 `finding` 行与旧 `compact` 头），不迁移、不换路径。

## 目标（DoD）

- 只暴露三个 tool：`tower_do`（任务 upsert/remove）、`tower_do_talk`（send/inbox）、
  `tower_do_status`（最小看板）。
- 不再有：全量替换写入、写租约/CAS/compaction/archive、findings、scope/changedFiles
  收据、presence/liveness sidecar、checkpoint digest、scope 冲突、git 段、legacy 迁移 shim。
- `state.ts` + `board.ts` + `index.ts` 显著缩小；门禁在 CI 上真的会红。

## 进度

阶段编号只在本文件使用；看板键是权威。映射：

| 本文件阶段 | 看板键 | 状态 |
| --- | --- | --- |
| P0 门禁 | `rw-gate` | done |
| 方式/计划 | `rw-plan` | done |
| P2 磁盘层（D1） | `rw-disk` | done |
| P1 写入语义 | `rw-core` | open |
| P3 tools 收敛 | `rw-tools` | open |
| P4a 消息投递（D2） | `rw-msg` | open |
| P4b 身份（D4） | `rw-identity` | open |
| P5 UI（D3） | `rw-ux` | open |
| P6 文档 | `rw-docs` | open |
| P7 清理 | `rw-cleanup` | open |

- [x] **P0 门禁** — CI `bun run <file>` → `bun <file>`（bun 1.4.0 下前者静默空跑且退出 0）。
- [x] **P2 磁盘层（D1）** — `board.ts` 去除租约/compaction/archive/CAS：
  `withLock`/`lease*`/`breakLock`/`reconcileStolenCompact`/`compact`/`pruneArchives` 全删；
  `append` 改单次 O_APPEND 写；`withWriteLock` → `withWrite`；fold 保留（含旧 `compact` 头容错）。
  `index.ts` 删 `gc` action、自动压缩调度、相关状态与提示；`state.ts` 删压缩常量。
  删除 `test/board-compact.ts` 与 smoke 中的 gc/compact 断言。tsc + 17 套件全绿。
- [ ] **P1 写入语义** — `tower_do.tasks` 改 upsert（列出即新建/合并补丁），删除走显式
  `remove: [key]`；`writeBoardSnapshot` 去掉"省略即删除"的全量替换与随之而来的移除守卫。
- [ ] **P3 tools** — 删 findings / scope / changedFiles / dashboard layers / presence；
  `tower_do_status` 收敛为 open tasks + completed 键账目 + unread + activity。
- [ ] **P4b 身份（D4）** — identity = `as` > config `identity` > session id；删 `sessionLabel`
  label entropy / alias / `sameAgent` 多时钟体系；stale takeover 只用 `task.updatedAt` 单时钟。
- [ ] **P5 UI** — 极简 widget + reminder。
- [ ] **P6 文档** — 重写 PRODUCT/ARCHITECTURE/CONTRACTS/OPERATIONS/DECISIONS/README。
- [ ] **P7 清理** — 删 `git-count.ts`、旧测试、legacy 迁移 shim、`docs/reviews`；门禁收口。

## 待确认

**方式变更需你确认**：原批准的是「方案 B 从零重写」，调研后改为「在已验证的存储核心上做减法
+ 改写入语义」。理由：磁盘事件格式已是干净的 per-entity 日志，重写 fold/校验只会重新引入
已被 40 个 fix 稳定下来的 bug。该变更只在分支 `refactor/core-two-features` 上，main 未动，
可随时放弃。若你仍要“从零重写”，在 P1 之前告知即可。

## 验证

- `bunx tsc --noEmit` 通过；新测试覆盖 fold（upsert/remove/旧行容错）、revision gate、
  owner guard、message send/inbox/ack、并发追加、upsert 不因省略删除。
- CI 上人为改坏一个断言，确认门禁变红。
