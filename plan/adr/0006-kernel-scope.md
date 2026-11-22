# ADR 0006：内核边界判据（Kernel Scope）

## 背景

`README.md` 与 `docs/ARCHITECTURE.md` 长期使用"内核极薄"的表述，并把内核描述为"6 个状态件 + 3 份契约"。实际 `kernel/` 已有 59 个源文件、约 10,700 行，除 EventBus / Config / PluginLoader / Trace / Cache / Budget 之外，还包含快照、锁文件、沙箱、插件进程宿主、任务契约与验收、工具账本、模型调用等模块。

依赖方向本身是干净的（`kernel/tests/dependency-boundary.spec.ts` 保证 kernel 不引 core/server/ui），所以问题不是"内核变脏"，而是**没有判据**：新文件该进 kernel 还是 core，只能靠感觉。继续按旧口径加文件，会让"什么该进内核"彻底失去标准。

## 决策

内核只接收以下三类内容，其余一律进 `core/` 插件或 `server/` host service：

1. **契约**：被 `kernel/plugin-sdk` 导出、插件必须依赖的类型与协议（`types`、`loop`、`service`、`tool-contract`、`task-contract`、`model-schema`）。
2. **跨插件机制**：多个插件共用、且不含产品语义的机制（EventBus、Config、EffectScope、Trace、Cache、Budget、Loader、Snapshot、Lock、Sandbox、Process Host、Replay、Journal、Validate）。
3. **进程级状态**：一个进程内必须唯一的状态件（内核实例、运行目录、密钥盒、写锁）。

判断顺序（任一条命中即不进内核）：

- 它是否描述某个具体业务（文档、搜索、记忆、技能、组织、社会、复盘）？→ 进 core 插件或 host service。
- 它是否只有单个插件或单个产品功能使用？→ 跟随该插件。
- 它是否需要知道宿主（HTTP、SQLite、租户、Run 生命周期）？→ 进 `server/`。
- 它是否只在测试或脚本里用？→ 进 `tests/` 或 `scripts/`。

新增内核文件时，提交说明必须写一句它属于上面哪一类；不属于任何一类就先放 `core/`。

## 后果

- `README.md` / `ARCHITECTURE.md` 的表述从"内核极薄（6 个状态件）"改为"内核只放机制与契约"，并给出当前规模，不再用"薄"掩盖文件数量。
- 计数随拆分更新：本轮把清单校验拆到 `kernel/plugin-manifest.ts` 后，内核为 **60 个源文件**（README / ARCHITECTURE 已同步）。
- kernel 仍可增长，但增长必须能被三类判据解释；无法解释的模块会被迁到 core。
- 插件方无感知：`kernel/plugin-sdk` 仍是唯一公共入口，插件 manifest 的 `3.0.0` 不变。

## 回滚

本 ADR 只约束"文件放哪"，不改变任何运行时行为；回滚即恢复旧文档表述，代码无需迁移。
