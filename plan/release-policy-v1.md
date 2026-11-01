# 版本、迁移与兼容策略 v1

本文是版本号、迁移日志、兼容承诺和弃用周期的唯一权威来源。代码实现与本策略不一致时，以修复实现或修订本文的方式对齐，不允许静默漂移。

## 版本来源

| 维度 | 版本载体 | 当前版本 | 版本规则 |
| --- | --- | --- | --- |
| 应用整体 | `web-agent/package.json` 的 `version` | 0.1.0 | 语义化版本；发布产物与代码版本一致 |
| HTTP API 契约 | `X-API-Schema-Version` 响应头（`server/api-contract.ts` 的 `API_SCHEMA_VERSION`） | 1 | 破坏性字段变更时递增 |
| 插件 manifest | `plugin.json` 的 `version` 与 `compatibility.api.min/max` | API 1.0.0 | 插件自管 semver；宿主 API 固定 1.0.0 |
| 数据库 schema | SQLite `PRAGMA user_version`（`server/db.ts` 的 `Store.DB_SCHEMA_VERSION`） | 1 | 每次破坏性 schema 变更 +1，并补 `MIGRATIONS` 步骤 |
| 插件内容快照 | 目录名 `@<10位hash>`（`kernel/plugin-snapshot.ts`） | — | 内容寻址，自动失效 |

发布前检查 `package.json` 版本与 CHANGELOG 最新条目一致。

## 兼容承诺

### HTTP API（schema v1）

- 新增响应字段：兼容，不递增版本。
- 改变字段语义或删除字段：递增 `API_SCHEMA_VERSION`，旧版本保留过渡期。
- 错误响应统一 `schemaVersion: 1`、`ok: false`、稳定 `code`，跨版本稳定。

### 数据库 schema（v1）

- 列级增量（新增可空列/带默认值列）：幂等 ALTER 兜底，不递增 `user_version`。
- 破坏性变更（改列类型、拆表、删列）：`DB_SCHEMA_VERSION` +1，`MIGRATIONS` 追加 `from → to` 事务化步骤。
- 更高版本的库 fail-closed 拒绝打开；迁移失败保留旧版本，可从启动备份恢复（`data/backups/` 保留 7 份）。

### 插件 manifest（v1）

- 宿主 API 版本固定 `1.0.0`；插件声明 `compatibility.api` 范围后按加载前校验执行，越界拒绝加载。
- 未声明 `compatibility` 的插件走 legacy trusted 路径（现有行为）。

## 迁移说明

迁移分两类，各自有独立日志：

1. **数据库迁移**：`Store.migrate` 执行,启动日志输出迁移结果；失败时抛错并保留旧版本，损坏现场存 `*.corrupt-<ts>`。
2. **插件快照迁移**：插件目录内容变化时重建 `@<hash>` 快照,旧快照由 `npm test` 的 `SNAPSHOT_DIR` 过滤逻辑排除,不影响测试可复现性。

每次发布涉及迁移时,在 CHANGELOG 中记录「版本 → 迁移内容 → 回滚方式」。

## 弃用周期

| 弃用对象 | 弃用信号 | 移除时机 |
| --- | --- | --- |
| HTTP API 字段 | 响应中标记 `deprecated: true` + CHANGELOG 记录 | 递增 schema 版本时一并移除,过渡期至少一个发布周期 |
| 环境变量 | README「环境变量」表标记弃用 + 启动日志 warning | 两个发布周期后移除 |
| 插件能力 kind | `kernel/types.ts` 中标记 `@deprecated` 注释 + loader 日志 | 主版本递增时移除 |
| 配置键 | `config.example.json` 注释标记弃用 + 启动日志 warning | 两个发布周期后移除 |

## 升级说明

升级步骤按 [DEVELOPMENT.md](../web-agent/docs/DEVELOPMENT.md) 执行 `git pull` 后 `npm ci` 双仓；数据库迁移与启动备份自动完成，无需手动干预。Windows 完整安装/恢复/数据目录运维步骤见 [windows-ops-runbook.md](windows-ops-runbook.md)。降级需要从 `data/backups/` 手动恢复最近备份，并回退到对应版本代码（更高 schema 版本的库不允许被旧代码打开）。
