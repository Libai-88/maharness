# ADR 0007：部署定位与扩展路径（Deployment Envelope）

## 背景

当前形态是**单进程 Express + 单库 better-sqlite3（同步 API）+ WAL**：写入天然串行，CPU 单线程，事件与任务状态都在同一个进程内存里（`server/run-service.ts` 的活动执行表、SSE 订阅表）。这在单机、单用户/小团队场景下是最省心的选择，但文档一直没写清它是**定位**还是**临时限制**。

缺定位的代价已经出现过：讨论"扩展性"时无法判断某处重构是必要还是过度设计；也无法回答"什么时候该换库"。

## 决策

1. **明确部署定位**：本地单机、单用户或小团队自托管；SQLite 是刻意选择，不是待偿技术债；不承诺 SaaS 级水平扩展。
2. **给定三条升级触发条件与对应路径**（命中才升级，不提前做）：
   - 活动 Run 常驻 > 8 或写入等待 p95 > 100ms → 进程内单写队列 + 批量提交（落地在 `server/store/write-queue.ts`）。
   - 单库 > 5GB 或需要多机共享 → 经存储端口换 PostgreSQL 适配器，**不改服务层**。
   - 需要硬多租户隔离 → 按租户分进程/分库，而不是改内核。
3. 目标值写进 `docs/ARCHITECTURE.md` 的 NFR 段：同时 8 个活动 Run、HTTP p95 < 200ms（不含模型调用）、SSE 首帧 < 50ms、RTO < 1 分钟。
4. **明确不做**：微服务化、外部队列/缓存、K8s、完整事件溯源 replay（重放历史事件重建状态）。

## 后果

- "扩展性差"从缺陷变成有边界的已知取舍，评审时不再反复讨论同一件事。
- 换库成本被限制在适配器一层（依赖 ADR 的端口化落地）。
- 反向约束：任何新增功能不得引入"必须多进程才能工作"的设计（例如进程内内存态必须可重建）。

## 回滚

本 ADR 只是定位声明；回滚等于删掉该段声明，不影响代码。

## 落地记录（2026-11-22）

- 单写队列已随 v4 第 4 期实现：`server/store/write-queue.ts`（重入不排队、`SQLITE_BUSY` 只重试一次、`stats()` 可观测），`RunRepository.transaction` 全部经过它；实测 `server/store/write-queue.ts` 行覆盖 100%（`server/tests/store-queue.spec.ts`）。
- 端口化已实现第一层（`server/store/ports.ts` + `server/store/sqlite.ts` identity 适配器）；**SQL 仍留在 `server/db.ts`**，按本 ADR"命中触发才搬家"的原则，换 PostgreSQL 时只实现同一组端口接口。
- 触发条件未命中：单机实测写入延迟远低于 100ms p95，故未做批量提交。
