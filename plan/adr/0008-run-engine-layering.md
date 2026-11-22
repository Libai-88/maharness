# ADR 0008：Run 引擎分层（Journal / State / Ledger / Executor）

## 背景

`server/run-service.ts`（1,381 行）同时承担 8 类职责：入口校验与幂等、记录构造与初始历史、SSE 发布与订阅、执行调度与并发池、断点恢复、工具账本与副作用核对、模型调用预算与用量记账、终止状态收敛与组织收尾。

后果是可复现的：任何一处改动都要先判断"会不会影响别处"，状态转移（queued → running → waiting_approval → interrupted/deadline → cancelled/failed/completed）没有单一真相，只能靠读完整文件推断；恢复路径（`recoverCheckpoint` + `resumeChildren`）与执行路径混在同一命名空间。

## 决策

1. `RunService` 保留为**门面**，对外方法签名不变（`create` / `resume` / `cancel` / `supplement` / `delegate` / `subscribe` / 权限方法 / `shutdown`）。
2. 内部拆为五个模块，放在 `server/run/`：
   - `state.ts`：**纯函数**状态收敛（`statusAfterAbort` / `terminalStatus` / `isActive`），是状态转移的唯一真相；无 IO、可单测、可列举。
   - `journal.ts`：`RunJournal` 负责事件发布与订阅表，同时维护订阅者可见的 `record` 快照。
   - `ledger.ts`：`RunLedger` 负责模型调用准入（父子预算预留）、用量增量、祖先传播与账单提示。
   - `recovery.ts`：断点核对与重放禁止（pending 副作用不自动重放）的判定。
   - `executor.ts`：`executeRun(runtime, record, abort, resumed)` 承载一次执行的循环与收尾。
3. 事件日志**只追加**，不做"重放重建状态"的事件溯源：状态仍以 `RunRecord` 为准，历史事件只用于解释与补读。
4. 恢复路径与执行路径共享 `runtime`（store / runner / plugins / organization / pool / journal），但**不共享隐式状态**：需要跨阶段传递的值必须显式放在 `runtime` 或 `record`。

## 后果

- 状态收敛可以被表驱动测试覆盖，恢复判定可以被单测穷举 pending/done/缺失三种副作用结果。
- 执行器与账本可以分别替换（换执行池、换记账策略不动门面）。
- 短期存在一层门面转发；`run-service.ts` 从 1,381 行降到数百行，改动成本的判据从"读全文件"变成"看模块职责"。
- 风险：拆分若改动语句顺序会改变审批/预算时序，因此拆分以**原样迁移**为准，仅重命名 `this.` → `runtime.`，行为差异由既有 Run 用例兜底。

## 回滚

保留门面即保留回滚面：若某模块出现回归，可把该模块函数体搬回门面类，其他模块不动。
