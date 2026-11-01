# 发布 / 回滚检查表

每次发布（tag 或对外声明版本）按顺序逐项勾选；任一项未通过则不发布。检查结果贴入该次发布的 CHANGELOG 条目或 release note。

## 发布检查

1. 版本一致性：`web-agent/package.json` `version` 与 CHANGELOG 最新条目一致；`ui/package.json` 同步。
2. 数据库 schema：涉及 schema 变更时 `Store.DB_SCHEMA_VERSION` 已递增且 `MIGRATIONS` 含对应步骤；`npm run eval:ci` 全绿。
3. API schema：涉及契约变更时 `API_SCHEMA_VERSION` 已按 release-policy 递增；`npm test` 的 api-contract 契约扫描 + `node scripts/check-doc-facts.mjs` 通过。
4. 插件 manifest：涉及 manifest 语义变更时 `manifest-v1-compatibility.md` 与 `HOST_PLUGIN_API` 同步；`npm run plugin:validate` 双插件通过。
5. 安全门禁：`npm run test:security` 全绿；`npm run check:threat-model` 通过；威胁模型在安全边界变更时已升版。
6. 完整回归：`npm test`、`npm run typecheck`、`npm run ui:typecheck`、`npm run build`、`npm run selftest`、`npm run eval:ci` 全绿；GitHub Actions quality + e2e 双绿。
7. 文档事实：CHANGELOG 覆盖全部面向用户的变化；环境变量表与实际实现一致；ADR 在重大契约改动时已登记。
8. 供应链：`npm audit --omit=dev` 双仓 0 漏洞；锁文件变更仅含本版本有意引入的修复/升级。

## 回滚检查

1. 代码回退：`git checkout <上一版本 tag>` → `npm ci` 双仓 → 全量回归（`npm test` + `npm run eval:ci`）。
2. 数据回退：停止服务 → `data/backups/` 选目标版本启动时生成的备份 → 按 `windows-ops-runbook.md` 手动恢复步骤拷回 `agent.db`（删 WAL/SHM 伴生）→ 启动确认 `integrity_check` 通过。
3. schema 降级限制：确认上一版本代码的 `DB_SCHEMA_VERSION` ≥ 目标备份版本；更高 schema 的库不允许被旧代码打开（fail-closed）。
4. 配置回退：`.env` 恢复到上一版本支持的变量集合；已弃用变量按 release-policy 弃用周期判断。
5. 插件回退：恢复插件目录旧版本文件（内容哈希自动回到旧快照）或停用插件；manifest `compatibility.api` 不兼容时插件拒绝加载为预期行为。
6. 发布公告：在 CHANGELOG 标注回滚版本与原因；涉及安全修复的回滚需评估是否引入已知漏洞。
