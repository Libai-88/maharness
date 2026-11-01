# API schema v1

公开 `/api/*` 响应统一携带 `X-API-Schema-Version: 1`。响应体保持既有形状，以兼容现有前端；核心控制面所有显式 Express 路由登记在 `web-agent/server/api-contract.ts`，契约测试扫描路由源文件并阻止登记遗漏。登记项包含可执行 JSON Schema 子集，运行时校验成功响应的必要字段和基础类型。

契约漂移由 CI 门禁自动校验：`server/tests/api-contract.spec.ts` 扫描全部 `server/routes/*.ts` 源文件中的显式路由声明，任何未登记路由使测试失败；`server/scripts/check-doc-facts.mjs` 在每次 CI 执行中核对 `api-contract-v1.md` 引用的契约字段（当前 `GET /api/security` 的 `bind`/`deployMode`/`tls`/`mutationAuthRequired`/`mutationTokenHeader`/`approvalTokenRequired`）与 `api-contract.ts` 中 schema 登记一致，不一致即失败。契约变更流程：改路由 → 登记契约与 schema → 更新本文相应描述 → 三处校验全绿。

错误响应继续使用 `schemaVersion: 1`、`ok: false`、稳定 `code` 与用户可读 `error`。插件 manifest/API 能力可按 `METHOD /path` 声明响应 schema；声明后由宿主统一校验，失败返回 `response_schema_invalid`，不向调用方发送不符合契约的成功体。插件自定义端点未声明 schema 时保持兼容运行。

新增字段向后兼容；改变字段语义或删除字段时提升 schema 版本，并保留旧版本过渡期。回滚时移除字段 schema、插件响应声明和响应校验包装器，保留原版本头与业务响应体。
