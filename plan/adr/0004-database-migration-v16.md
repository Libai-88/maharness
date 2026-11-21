# ADR 0004：数据库 v16 与不可变迁移

## 背景

`server/db.ts` 的 `MIGRATIONS` 在 v1→v7、v10→v12、v14→v15 多个步骤重复执行当前版本的完整 schema。版本号只表示“执行到当前 schema”，不是不可变历史脚本；修改 schema 常量会改变旧库重放结果。

## 决策

1. `DB_SCHEMA_VERSION` 升到 16；最低支持从 v15 升级，v14 及以下 fail-closed，必须导出/恢复备份。
2. 新增 `server/migrations/`：`001_v15_baseline.sql`、`002_v16.sql`、`manifest.json`（含 SHA-256）。
3. 使用 `schema_migrations` 表记录版本、文件名、checksum、耗时；每次打开校验已应用文件 checksum。
4. 删除 `Store.MIGRATIONS` 和 `server/migration-lock.ts`；新增迁移测试 fixture 和 `db:export`/`db:upgrade` 脚本。
5. v16 只做明确列级增量：`society_tasks_v1.capability_source`、`team_mode`、`experience_reviews_v1.reviewer_model`（最终列名以实现为准）。

## 后果

- 破坏旧库自动升级能力；必须提供备份/导出路径和发布说明。
- 新库和 v15 库走两套确定路径，迁移可重放、可审计。
- 后续 schema 变更只能追加新 SQL 文件，不允许修改已发布文件。

## 回滚

回退代码到 schema 15 前，停止服务并恢复 `data/backups/` 的 v15 备份；schema 16 的库不能被旧代码打开。