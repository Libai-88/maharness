# API 契约 v2（2026-11-21）

本版本是 maharness `0.2.0` 的公开 HTTP 契约。所有 `/api/*` 响应携带 `X-API-Schema-Version: 2`。

## 与 v1 的破坏性差异

| 端点 | v1 | v2 |
| --- | --- | --- |
| `POST /api/organization/society/tasks` | 可省略能力，服务端按关键词猜 | 必须显式传 `requiredCapabilities`（1–20 个字符串）与 `needsWrite`（布尔），缺失返回 `400 TASK_CAPABILITIES_REQUIRED` |
| `POST /api/organization/society/tasks` | 无团队模式字段 | 新增可选 `teamMode: 'auto' \| 'solo' \| 'team'` |
| `GET /api/organization/society` | `health.score` 等合成健康分 | 删除 `health`；新增 `observations[]`（每项含 `id/label/value/unit/numerator/denominator/sampleSize/quality/formula`） |
| `GET /api/workbench/summary` | `society.health` | `society.observations` |
| 复盘 | 默认用任务模型自评 | 可在评价标准中配置 `review.providerId/review.model`；请求显式传入优先 |
| `POST /api/organization/society/tasks` 返回 | 无来源字段 | 任务包含 `capabilitySource: 'explicit' \| 'legacy_heuristic'` |

## 社会观察指标

`observations` 不使用合成总分。每项指标自带公式与样本量：

- `load_balance`：角色活跃任务负载的标准差 / 平均值。
- `welfare`：按角色计算 `1 - 活跃任务 / 福利上限` 后取平均。
- `exception_backlog`：未结异常计数。
- `budget_utilization`：`(已预留 + 已花费) / 社会预算`。
- `collaboration`：只来自实际人工复核事件的关系分平均；无样本时 `quality = 'unknown'`。

`quality` 取值：`observed`（≥3 样本）、`insufficient`（1–2 样本）、`unknown`（无样本）。

## 复盘评审

`review` 路径与 v1 相同，新增语义：

1. `review.providerId` / `review.model` 进入评价标准版本，随制度审计。
2. 原工作模型不可用时仍返回 `409 ORIGINAL_MODEL_UNAVAILABLE`。
3. reasoning 模型可使用总预算余量作为输出上限；总预算仍是硬上限。
4. 建议的 `category` 兼容字符串与单元素数组两种输入形状。

## 兼容与弃用

- v1 客户端若依赖 `health.score` 或省略能力字段，将在 v2 收到 400 或字段缺失；这是有意破坏。
- v1 契约文档保留为历史记录，不再更新字段清单。
- 数据库最低支持 v15；v14 及以下请先 `npm run db:export` 或恢复备份。
