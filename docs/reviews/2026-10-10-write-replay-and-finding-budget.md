# 写入重放与 finding 预算：实测到的三个落点（2026-10-10）

> **Resolved (2026-10-10).** P1/P2 fixed: the `tower_do_status` guideline and the
> completed-row guard hint now state that a write must enumerate completed
> receipts too (an omitted completed key is a removal, rejected by the owner
> guard). P3 fixed: the finding-budget rejection annotates each named row with
> its hold state (`no live claim` / `held by … (live)` / `snoozed, no live
> holder`) and frames the remedy as a drain of an unheld row, not a blind
> judgment on a live claim; it names a `drain target` when the top-5 shows only
> held rows, and an all-held backlog gets a wait/ask remedy.
> P4: `TowerBoard.compact` is asserted (new `test/board-compact.ts` cases) to be
> an equivalent rewrite that never reduces the task key set; the proposed
> `dropKeys` gate was rejected. Durable rules folded into DECISIONS.md ("write
> replay names receipts; compaction never reduces the key set") and CONTRACTS.md
> (finding budget hold-state evidence).

短期材料（`docs/reviews/`）。触发场景：另一个项目（WingGate，板 `home-wweir-Mine-WingGate-fed3321e`，
209 key = 10 open + 199 completed）上的一次独立会话，需要 (a) 登记自己的分析任务、(b) 把两条带证据的
finding 上报。两件事都失败，过程与根因记录如下。

只做只读取证：两个可复现报错 + 若干 `file:line`。**没有改代码、没有跑 `bun test`**。

## 一、结论（先说不是缺陷的部分）

`MAX_TOWER_DO_OPEN_TASKS` 的"完成回执行重放免费、不占容量"与 finding 预算的"超额板只能 drain"都是
**已论证的取舍**，本次实测没有推翻它们：

- `docs/DECISIONS.md` "2026-09 — open-task budget: completed rows never block a new plan"（:321-351）已明确
  "replay is mandatory"，并显式否决 sticky-completed omission（省略即保留）："then nothing could ever
  remove one, and the board would grow without bound in the folded view"。
- 同节 "Known limit"（:367-）也已写明这条取舍的现实天花板："Completed history is unbounded now, and every
  write must name the rows it keeps — so the practical ceiling is what a caller can *read*"。
- `docs/CONTRACTS.md` "Finding contracts"（:306-316）已写明预算按 non-closed 计、claim/snooze 都占位、
  "a legacy over-cap board can always DRAIN (only an increase that would exceed the cap is rejected)"。

所以下面四条是"仍应修的落点"，不是"这套设计错了"。

## 二、实测（原始报错）

**1) 任务写入被拒**（payload = 3 条新任务 + 重放全部 10 个 open key，未重放 completed 行）：

```
task sshadd-manual is owned by "session-01a0aebf" — only its owner or tower may remove it
(a completed task stays with its owner — only that owner or an as: "tower" write that replays
the rows to keep may drop it; a peer cannot forge a receipt)
```

`sshadd-manual` 是 199 条 completed 之一，不属于我。也就是说：**未枚举的 completed 回执会被判成"丢弃"**，
于是"新增 1 条任务"实际要求重放全部 209 个 key。

**2) finding 写入被拒**（两次；第二次另行被 `location` ≤ 256 字符的校验拒，那是我自己的 payload 问题）：

```
non-closed findings are at the budget (50): close one first — a snooze still occupies a slot,
so it frees nothing.
  most pressing: f-0c3d55a6-bb9 (33d, low/improve), f-044c2b70-a4f (31d, medium/improve), …
  remedy: tower_do_talk action=finding findingIds=[…] status=done|rejected reason=…
```

**3) 同一块板的 dashboard 自己印出超额计数**：

```
Open findings (68/50 non-closed · 68 actionable · 0 claimed · 0 snoozed · 1 closed<7d · 31 retired)
```

## 三、仍应修的落点

### P1（文档冲突，实际让我被拒）— `index.ts:2915`

宿主在写板前注入的指南写着：

> Before a tower_do write, make sure the whole board is in view: the folded `## Others` ledger already
> names every open key (view=all adds their rows), and a key omitted from the write is removed —
> **the default view's ledger is the minimum you must enumerate**.

而写入契约（`index.ts:603`）要求 **"every key you want kept must appear here"**，且 completed 行的省略被
`state.ts:2895`（`staleClaimHint` 的 completed 分支）判成丢弃。两者在"必须枚举什么"上互相矛盾：
指南说 open key 是最小集合，契约说含 completed 回执。

后果：按指南操作的调用方必然被拒，且失败时 host 会把整个 payload 原样回显（描述自己还提醒
"a small replay keeps that echo cheap"），所以试错本身也昂贵；`DECISIONS.md` 的 "Known limit" 承认天花板
是"调用方能读到什么"，那么指南这一句就应当写清"completed 的 key 也要重放"。

**建议**：改这一句（成本一行）。可选：拒绝文案里也点名"未枚举的 completed key 同样算丢弃"。

### P2（拒绝文案没说清补救的实际代价）

拒绝文案只陈述了 completed 行的守卫规则，没说"你必须把它们全部枚举出来"。调用方拿到的信息是
"你不能删它"，而不是"你要列全它"。在 200+ key 板上这两句话差别就是一次失败往返。
建议在 `state.ts:2879`/`index.ts:3288` 的补救文案里补全枚举要求（或直接指到 P1 修正后的指南）。

### P3（finding 预算的 remedy 把"关别人的单"当解法）

拒绝文案的 remedy 是 `findingIds=[…] status=done|rejected reason=…`，且实现不限制跨 owner 关闭；
而它给出的候选（`findingPressureOrder` 的 top-5）实测全是 **30+ 天、无人认领、low/improve** 的旧债。
于是唯一出路是让一个不了解上下文的 agent 对这些行下终止判断，并给出 reason —— 这既没有可验证依据，
也鼓励"为腾位而虚假关闭"，与 owner guard 的精神相反。

建议：给这类"超期未认领 + 无人 hold"的行一条**可审计的系统化降级**（例如一条 `rejected`，reason 记为
`budget overflow`，由板自己写系统事件），而不是要求 peer 逐个下判断；或至少在拒绝文案里标注每个候选
"可安全关闭"的依据（无人认领 / 超期 / 无 live owner）。

### P4（`tower` 不是可验证身份，却是唯一的压缩/丢弃通道）

`index.ts:615` 自述"Identities are self-declared labels (cooperative trust, no authentication)，所以保留的
`tower` 标签只按约定把关"；`index.ts:592` 的压缩要求 `as: "tower"`；`state.ts:2895` 允许它丢弃别人的
completed 回执。因此"别人不能静默丢弃我的行"这条不变量最终只靠约定，越权没有机制代价（事件里记的也是
自述身份）。

建议：压缩只允许"等价重写/合并"，**不允许减少 key 集合**（减少须显式 `dropKeys`，且每个 key 满足保留期
校验），并在事件里同时记录自述身份与调用来源（进程/会话），让越权可归因。

## 四、未验证

- 未通读 `board.ts`/`state.ts` 的完整写入管线，只按报错与常量/守卫取证（`state.ts:46` `MAX_TOWER_DO_OPEN_TASKS`、`:67` `MAX_TOWER_DO_OPEN_FINDINGS`、`:2407-2417` 预算判定、`:2895` 移除守卫、`index.ts:603/615/592/2915`）。
- 未跑 `bun test`；未追溯 68/50 的成因（cap 调低 vs 旧路径写入）。
- P1 若已被某处决策明文覆盖（"ledger 是最小集合"是有意为之），那么我这条应改成"决策需回写/指南需删除"，而非"指南写错"——我只确认了 `docs/DECISIONS.md` 与 `docs/CONTRACTS.md` 里没有这句话。
