# maharness v2 真实任务对照评测

发布验收：未通过。完成样本 540/540。

评分使用 scored-samples.jsonl；原始执行记录保留在 samples.jsonl。评分修订依据保存在 scoring-audit.json，产物快照保存在 artifact-evidence.jsonl。JSON 对象按内容比较，键顺序不影响结果；模型请求和登记操作未重放。

540 个样本在同一冻结执行源码上完成。执行运行时未变；评分器按 JSON 语义比较修订，所有产物统一复核，原始样本与评分审计分别保留。

三组使用一致的任务材料、工具和模型请求参数。baseline 加载归档运行时，reference 使用最小循环，v2 使用持久任务服务与当前循环。恢复任务从持久断点继续，产物由文件及可执行断言核对。

| 模型请求标识 | 组别 | 成功数 / 样本数 | 成功率 | 模型调用中位数 | 输入 / 输出 token 中位数 |
| --- | --- | --- | --- | --- | --- |
| group/never-stuck | baseline | 89 / 90 | 98.9% | 4 | 10193 / 2182.5 |
| group/never-stuck | reference | 88 / 90 | 97.8% | 5 | 10935.5 / 992 |
| group/never-stuck | v2 | 88 / 90 | 97.8% | 6 | 17153 / 1318.5 |
| workbuddy/hy4free | baseline | 82 / 90 | 91.1% | 4 | 9858 / 1676.5 |
| workbuddy/hy4free | reference | 86 / 90 | 95.6% | 6 | 11444.5 / 948.5 |
| workbuddy/hy4free | v2 | 85 / 90 | 94.4% | 6 | 15334 / 1226 |

## 分类结果

| 模型档 | 分类 | 组别 | 成功 / 样本 |
| --- | --- | --- | --- |
| route-1 | code | baseline | 18 / 18 |
| route-1 | code | reference | 18 / 18 |
| route-1 | code | v2 | 18 / 18 |
| route-1 | research | baseline | 17 / 18 |
| route-1 | research | reference | 17 / 18 |
| route-1 | research | v2 | 18 / 18 |
| route-1 | document | baseline | 18 / 18 |
| route-1 | document | reference | 18 / 18 |
| route-1 | document | v2 | 17 / 18 |
| route-1 | recovery | baseline | 18 / 18 |
| route-1 | recovery | reference | 17 / 18 |
| route-1 | recovery | v2 | 17 / 18 |
| route-1 | tool-failure | baseline | 18 / 18 |
| route-1 | tool-failure | reference | 18 / 18 |
| route-1 | tool-failure | v2 | 18 / 18 |
| route-2 | code | baseline | 17 / 18 |
| route-2 | code | reference | 18 / 18 |
| route-2 | code | v2 | 16 / 18 |
| route-2 | research | baseline | 18 / 18 |
| route-2 | research | reference | 17 / 18 |
| route-2 | research | v2 | 18 / 18 |
| route-2 | document | baseline | 17 / 18 |
| route-2 | document | reference | 17 / 18 |
| route-2 | document | v2 | 18 / 18 |
| route-2 | recovery | baseline | 16 / 18 |
| route-2 | recovery | reference | 18 / 18 |
| route-2 | recovery | v2 | 18 / 18 |
| route-2 | tool-failure | baseline | 14 / 18 |
| route-2 | tool-failure | reference | 16 / 18 |
| route-2 | tool-failure | v2 | 15 / 18 |

## 发布门禁

| 检查 | 结果 | 依据 |
| --- | --- | --- |
| matrix | 通过 | 540 samples |
| performance-revision | 通过 | 540 个样本在同一冻结执行源码上完成。执行运行时未变；评分器按 JSON 语义比较修订，所有产物统一复核，原始样本与评分审计分别保留。 |
| model-identity | 未通过 | Every call must match the fixed model version; route names alone are insufficient |
| reference-success:route-1 | 通过 | Maximum success-rate decline: 5 percentage points |
| baseline-success:route-1 | 未通过 | Success rate must meet the old baseline |
| cost:route-1 | 无法确认 | Maximum median cost increase: 15%; zero-price or missing-cost samples cannot measure a percentage increase |
| confirmations:route-1 | 通过 | Unnecessary confirmations must not increase |
| reference-success:route-2 | 通过 | Maximum success-rate decline: 5 percentage points |
| baseline-success:route-2 | 通过 | Success rate must meet the old baseline |
| cost:route-2 | 无法确认 | Maximum median cost increase: 15%; zero-price or missing-cost samples cannot measure a percentage increase |
| confirmations:route-2 | 通过 | Unnecessary confirmations must not increase |
| duplicateEffects | 通过 | No observed violations |
| permissionViolations | 通过 | No observed violations |
| eventGaps | 通过 | No observed violations |
| validation:typecheck | 通过 | validation-details.json#build; npm run build; log SHA-256 f34c441c66d3ff9ccc5cbc18d85efc54342c958e738118b0bcd24423bcb0685a |
| validation:unit | 通过 | validation-details.json#unit; npm test; log SHA-256 51d67f61ba0870156cfb078ea4334473f828e12fcb86e72da99914111059eeac |
| validation:security | 通过 | validation-details.json#security; npm run test:security; log SHA-256 a12a89ba43910b17c9c26d4c50a1581192f0bc02ef17eb9cf3f3a0a86da76c03 |
| validation:build | 通过 | validation-details.json#build; npm run build; log SHA-256 f34c441c66d3ff9ccc5cbc18d85efc54342c958e738118b0bcd24423bcb0685a |
| validation:desktop | 通过 | validation-details.json#browser; npm run e2e; log SHA-256 68d30d5450e302ef23d63c12e9bb862c83211800d3c57bb02db0f004f236dc9e |
| validation:narrow-screen | 通过 | validation-details.json#browser; npm run e2e; log SHA-256 68d30d5450e302ef23d63c12e9bb862c83211800d3c57bb02db0f004f236dc9e |
| validation:accessibility | 通过 | validation-details.json#browser; npm run e2e; log SHA-256 68d30d5450e302ef23d63c12e9bb862c83211800d3c57bb02db0f004f236dc9e |
| validation:reconnect | 通过 | validation-details.json#browser; npm run e2e; log SHA-256 68d30d5450e302ef23d63c12e9bb862c83211800d3c57bb02db0f004f236dc9e |
| validation:migration-rollback | 通过 | validation-details.json#unit; npm test; log SHA-256 51d67f61ba0870156cfb078ea4334473f828e12fcb86e72da99914111059eeac |
| validation:plugin-contract | 通过 | validation-details.json#plugin-contract; npm run plugin:lock:verify; log SHA-256 4444b14bed981f7f7cae4f2267ba3526596f3473ce9071678a47f5bb1e15f1eb |

## 证据边界

模型身份来自网关原始响应；仅返回路由别名时，报告不认定固定底层版本。免费模型的真实账单为零，无法以零为分母判断 15% 费用增幅；调用与 token 单独列出。

模型请求次数：2920；报告输入 token：8622655；报告输出 token：884150。

usage 完整样本：519/540。缺失 usage 的请求不记为已知 token 成本。

重复副作用统计限于登记订单场景。权限和事件安全结论同时依赖确定性安全、恢复及租户测试。研究任务使用固定本地材料，结果不能外推为开放网络检索质量。运行参数、原始样本、模型响应身份与工具记录分别保存在 manifest.json 和 samples.jsonl。

## 未通过样本

| 模型档 | 任务 | 组别 | 次数 | 失败依据 |
| --- | --- | --- | --- | --- |
| route-2 | code-group | v2 | 1 | LLM 请求失败 [eval-75e4aa70-6667-43d4-ac6a-8dfafc966e33] 400: {"error":{"code":null,"message":"WorkBuddy: Invalid request parameters","param":null,"type":"invalid_request_error"}}  |
| route-1 | research-source-5 | reference | 1 | latest audited source and provenance |
| route-2 | document-csv-summary | baseline | 3 | document artifact requirements |
| route-2 | tool-failure-transient-read | v2 | 1 | recovered value；artifact updated after fault |
| route-2 | tool-failure-truncated-read | reference | 1 | recovered value；artifact updated after fault |
| route-2 | tool-failure-missing-path | baseline | 1 | LLM 请求失败 [eval-e4a934ca-6c81-4130-98fd-395c491f5719] 400: {"error":{"code":null,"message":"WorkBuddy: Invalid request parameters","param":null,"type":"invalid_request_error"}}  |
| route-1 | document-table | v2 | 3 | 已停止 |
| route-2 | code-group | baseline | 2 | executable code assertions |
| route-1 | recovery-ledger-2 | reference | 2 | The operation was aborted due to timeout |
| route-2 | recovery-ledger-3 | baseline | 2 | durable receipt；side effect occurred once |
| route-2 | code-group | v2 | 2 | executable code assertions |
| route-2 | tool-failure-truncated-read | v2 | 3 | LLM 请求失败 [eval-d1b1c708-c831-4cc9-900f-7f5f3cae43fb] 400: {"error":{"code":null,"message":"WorkBuddy: Invalid request parameters","param":null,"type":"invalid_request_error"}}  |
| route-1 | recovery-ledger-2 | v2 | 3 | 必需上下文需要 52438 tokens，超过当前可用容量 51000；请选择更大窗口的模型或缩减任务约束 |
| route-2 | tool-failure-version-conflict | baseline | 2 | 已停止 |
| route-2 | tool-failure-truncated-read | baseline | 1 | recovered value；artifact updated after fault |
| route-2 | document-release-notes | reference | 1 | document artifact requirements |
| route-1 | research-source-5 | baseline | 1 | latest audited source and provenance |
| route-2 | tool-failure-missing-path | reference | 3 | LLM 请求失败 [eval-b821f0a3-65ad-463c-9c68-834c8edd4e31] 400: {"error":{"code":null,"message":"WorkBuddy: Invalid request parameters","param":null,"type":"invalid_request_error"}}  |
| route-2 | recovery-ledger-3 | baseline | 1 | durable receipt；side effect occurred once |
| route-2 | tool-failure-version-conflict | baseline | 3 | fault exercised；recovered value；artifact updated after fault |
| route-2 | research-source-5 | reference | 3 | latest audited source and provenance |
| route-2 | tool-failure-version-conflict | v2 | 1 | fault exercised；recovered value；artifact updated after fault |
