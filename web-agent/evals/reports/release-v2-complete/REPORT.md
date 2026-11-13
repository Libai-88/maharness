# maharness v2 真实任务对照评测

发布验收：未通过。完成样本 540/540。

本矩阵包含两档模型共 540 次完整对照，性能样本对应 evaluated-sources.json 中的源码。最终交付另包含搜索读取边界修复，该修复已通过确定性检查，但本矩阵不能证明修复后版本的任务成功率。旧 v2 与额度耗尽线路不计入此矩阵，原始记录保留在各自目录。

三组使用一致的任务材料、工具和模型请求参数。baseline 加载归档运行时，reference 使用最小循环，v2 使用持久任务服务与当前循环。恢复任务从持久断点继续，产物由文件及可执行断言核对。

| 模型请求标识 | 组别 | 成功数 / 样本数 | 成功率 | 模型调用中位数 | 输入 / 输出 token 中位数 |
| --- | --- | --- | --- | --- | --- |
| group/never-stuck | baseline | 79 / 90 | 87.8% | 5 | 12294.5 / 2551 |
| group/never-stuck | reference | 81 / 90 | 90.0% | 7 | 16245 / 1730 |
| group/never-stuck | v2 | 74 / 90 | 82.2% | 8 | 23970 / 2439.5 |
| workbuddy/hy4free | baseline | 64 / 90 | 71.1% | 4 | 9543 / 2238 |
| workbuddy/hy4free | reference | 79 / 90 | 87.8% | 7 | 14751.5 / 2152.5 |
| workbuddy/hy4free | v2 | 67 / 90 | 74.4% | 8 | 22752 / 2429 |

## 分类结果

| 模型档 | 分类 | 组别 | 成功 / 样本 |
| --- | --- | --- | --- |
| tier-1 | code | baseline | 18 / 18 |
| tier-1 | code | reference | 17 / 18 |
| tier-1 | code | v2 | 18 / 18 |
| tier-1 | research | baseline | 17 / 18 |
| tier-1 | research | reference | 18 / 18 |
| tier-1 | research | v2 | 18 / 18 |
| tier-1 | document | baseline | 17 / 18 |
| tier-1 | document | reference | 18 / 18 |
| tier-1 | document | v2 | 18 / 18 |
| tier-1 | recovery | baseline | 11 / 18 |
| tier-1 | recovery | reference | 13 / 18 |
| tier-1 | recovery | v2 | 7 / 18 |
| tier-1 | tool-failure | baseline | 16 / 18 |
| tier-1 | tool-failure | reference | 15 / 18 |
| tier-1 | tool-failure | v2 | 13 / 18 |
| tier-2 | code | baseline | 17 / 18 |
| tier-2 | code | reference | 17 / 18 |
| tier-2 | code | v2 | 16 / 18 |
| tier-2 | research | baseline | 13 / 18 |
| tier-2 | research | reference | 17 / 18 |
| tier-2 | research | v2 | 17 / 18 |
| tier-2 | document | baseline | 16 / 18 |
| tier-2 | document | reference | 18 / 18 |
| tier-2 | document | v2 | 16 / 18 |
| tier-2 | recovery | baseline | 2 / 18 |
| tier-2 | recovery | reference | 14 / 18 |
| tier-2 | recovery | v2 | 6 / 18 |
| tier-2 | tool-failure | baseline | 16 / 18 |
| tier-2 | tool-failure | reference | 13 / 18 |
| tier-2 | tool-failure | v2 | 12 / 18 |

## 发布门禁

| 检查 | 结果 | 依据 |
| --- | --- | --- |
| matrix | 通过 | 540 samples |
| performance-revision | 未通过 | 本矩阵包含两档模型共 540 次完整对照，性能样本对应 evaluated-sources.json 中的源码。最终交付另包含搜索读取边界修复，该修复已通过确定性检查，但本矩阵不能证明修复后版本的任务成功率。旧 v2 与额度耗尽线路不计入此矩阵，原始记录保留在各自目录。 |
| model-identity | 未通过 | Every call must match the fixed model version; route names alone are insufficient |
| reference-success:tier-1 | 未通过 | Maximum success-rate decline: 5 percentage points |
| baseline-success:tier-1 | 未通过 | Success rate must meet the old baseline |
| cost:tier-1 | 无法确认 | Maximum median cost increase: 15%; zero-price or missing-cost samples cannot measure a percentage increase |
| confirmations:tier-1 | 通过 | Unnecessary confirmations must not increase |
| reference-success:tier-2 | 未通过 | Maximum success-rate decline: 5 percentage points |
| baseline-success:tier-2 | 通过 | Success rate must meet the old baseline |
| cost:tier-2 | 无法确认 | Maximum median cost increase: 15%; zero-price or missing-cost samples cannot measure a percentage increase |
| confirmations:tier-2 | 通过 | Unnecessary confirmations must not increase |
| duplicateEffects | 通过 | No observed violations |
| permissionViolations | 通过 | No observed violations |
| eventGaps | 通过 | No observed violations |
| validation:typecheck | 通过 | .build-v2-closure.log: backend and UI typechecks passed on final search-boundary repair |
| validation:unit | 通过 | .test-v2-closure.log: 1200 tests, 1199 passed, 1 skipped, 0 failed; .release-report-closure.log: 8/8 report checks passed |
| validation:security | 通过 | .security-v2-closure.log: 382/382 passed, includes native/JS search read boundary |
| validation:build | 通过 | .build-v2-closure.log: production build and both typechecks passed |
| validation:desktop | 通过 | .e2e-v2-closure.log: 84/84 browser tests, desktop main flows |
| validation:narrow-screen | 通过 | .e2e-v2-closure.log: 390px and 900px layout checks passed |
| validation:accessibility | 通过 | .e2e-v2-closure.log: axe serious/critical, keyboard, forms and dialog checks passed; automated coverage only |
| validation:reconnect | 通过 | .e2e-v2-closure.log: reconnect/resume passed; .test-v2-closure.log: process recovery, SSE cursor and subscriber disconnect passed |
| validation:migration-rollback | 通过 | .migration-plugin-v2-final.log: 69/69 passed, including failed DDL, backup integrity, rollback and preserved data/config; DB tests also passed in final unit suite |
| validation:plugin-contract | 通过 | .plugin-lock-v2-closure.log: external locks verified; .test-v2-closure.log: v2 loader and tool contracts passed; .selftest-v2-closure.log: 90/90 passed |

## 证据边界

模型身份来自网关原始响应；仅返回路由别名时，报告不认定固定底层版本。免费模型的真实账单为零，无法以零为分母判断 15% 费用增幅；调用与 token 单独列出。

模型请求次数：4021；报告输入 token：12709457；报告输出 token：1423853。

usage 完整样本：448/540。缺失 usage 的请求不记为已知 token 成本。

重复副作用统计限于登记订单场景。权限和事件安全结论同时依赖确定性安全、恢复及租户测试。研究任务使用固定本地材料，结果不能外推为开放网络检索质量。运行参数、原始样本、模型响应身份与工具记录分别保存在 manifest.json 和 samples.jsonl。

## 未通过样本

| 模型档 | 任务 | 组别 | 次数 | 失败依据 |
| --- | --- | --- | --- | --- |
| tier-1 | code-unique | reference | 3 | The operation was aborted due to timeout |
| tier-1 | research-source-6 | baseline | 3 | latest audited source and provenance |
| tier-1 | document-release-notes | baseline | 2 | 已停止 |
| tier-1 | recovery-ledger-1 | reference | 1 | The operation was aborted due to timeout |
| tier-1 | recovery-ledger-2 | baseline | 1 | 已停止 |
| tier-1 | recovery-ledger-3 | baseline | 1 | 已停止 |
| tier-1 | recovery-ledger-3 | reference | 1 | The operation was aborted due to timeout |
| tier-1 | recovery-ledger-3 | reference | 2 | The operation was aborted due to timeout |
| tier-1 | recovery-ledger-4 | baseline | 2 | 已停止 |
| tier-1 | recovery-ledger-4 | reference | 2 | The operation was aborted due to timeout |
| tier-1 | recovery-ledger-5 | baseline | 1 | LLM 流异常中断 [eval-fb5fb881-660a-4e7c-8169-e35d5112aab7]：连接已关闭但未收到 [DONE] 结束标记 |
| tier-1 | recovery-ledger-5 | baseline | 2 | 已停止 |
| tier-1 | recovery-ledger-4 | reference | 3 | The operation was aborted due to timeout |
| tier-1 | recovery-ledger-6 | baseline | 1 | 已停止 |
| tier-1 | recovery-ledger-6 | baseline | 2 | 已停止 |
| tier-1 | tool-failure-schema-read | baseline | 1 | 已停止 |
| tier-1 | tool-failure-missing-path | reference | 3 | The operation was aborted due to timeout |
| tier-1 | tool-failure-version-conflict | reference | 1 | The operation was aborted due to timeout |
| tier-1 | tool-failure-version-conflict | reference | 2 | The operation was aborted due to timeout |
| tier-1 | tool-failure-invalid-json | baseline | 3 | 已停止 |
| tier-1 | recovery-ledger-2 | v2 | 1 | 已停止 |
| tier-1 | recovery-ledger-2 | v2 | 2 | 已停止 |
| tier-1 | recovery-ledger-2 | v2 | 3 | 已停止 |
| tier-1 | recovery-ledger-3 | v2 | 1 | 已停止 |
| tier-1 | recovery-ledger-3 | v2 | 2 | 已停止 |
| tier-1 | recovery-ledger-4 | v2 | 1 | 本任务已达到轮数上限（30 轮）——已完成的工作已保存在会话中，可继续发送消息推进，或将任务拆小；长任务可调高 agent.maxTurns 配置 |
| tier-1 | recovery-ledger-4 | v2 | 2 | 本任务已达到轮数上限（30 轮）——已完成的工作已保存在会话中，可继续发送消息推进，或将任务拆小；长任务可调高 agent.maxTurns 配置 |
| tier-1 | recovery-ledger-5 | v2 | 2 | LLM 请求失败 [eval-96413440-a056-44a4-8683-ea201a9c7df1] 400: {"error":{"code":null,"message":"WorkBuddy: Invalid request parameters","param":null,"type":"invalid_request_error"}}  |
| tier-1 | recovery-ledger-6 | v2 | 1 | LLM 请求失败 [eval-5ff7f29d-2a02-49b3-9b9f-ca028425e0cd] 400: {"error":{"code":null,"message":"WorkBuddy: Invalid request parameters","param":null,"type":"invalid_request_error"}}  |
| tier-1 | recovery-ledger-5 | v2 | 1 | LLM 流异常中断 [eval-0543b894-f3f2-478f-ae2f-80dde9cec710]：连接已关闭但未收到 [DONE] 结束标记 |
| tier-1 | recovery-ledger-5 | v2 | 3 | cancelled |
| tier-1 | tool-failure-transient-read | v2 | 2 | 已停止 |
| tier-1 | tool-failure-transient-read | v2 | 3 | 已停止 |
| tier-1 | tool-failure-version-conflict | v2 | 1 | 已停止 |
| tier-1 | tool-failure-missing-path | v2 | 3 | 已停止 |
| tier-1 | tool-failure-version-conflict | v2 | 3 | recovered value；artifact updated after fault；fault exercised |
| tier-2 | code-median | baseline | 2 | executable code assertions |
| tier-2 | code-median | reference | 2 | executable code assertions |
| tier-2 | code-group | v2 | 2 | LLM 请求失败 [eval-3baefe90-c971-48ee-ab0e-134143b7fd4a] 400: {"error":{"code":null,"message":"WorkBuddy: Invalid request parameters","param":null,"type":"invalid_request_error"}}  |
| tier-2 | code-range | v2 | 1 | 已停止 |
| tier-2 | research-source-1 | baseline | 3 | latest audited source and provenance |
| tier-2 | research-source-1 | v2 | 3 | latest audited source and provenance |
| tier-2 | research-source-2 | baseline | 2 | latest audited source and provenance |
| tier-2 | research-source-3 | baseline | 3 | latest audited source and provenance |
| tier-2 | research-source-3 | reference | 3 | latest audited source and provenance |
| tier-2 | research-source-5 | baseline | 3 | latest audited source and provenance |
| tier-2 | research-source-6 | baseline | 1 | latest audited source and provenance |
| tier-2 | document-csv-summary | baseline | 1 | 已停止 |
| tier-2 | document-csv-summary | v2 | 2 | 已停止 |
| tier-2 | document-translation | baseline | 2 | document artifact requirements |
| tier-2 | document-translation | v2 | 1 | document artifact requirements |
| tier-2 | recovery-ledger-1 | baseline | 1 | durable receipt；side effect occurred once |
| tier-2 | recovery-ledger-1 | baseline | 2 | durable receipt；side effect occurred once |
| tier-2 | recovery-ledger-1 | reference | 2 | durable receipt；side effect occurred once |
| tier-2 | recovery-ledger-1 | v2 | 1 | 已停止 |
| tier-2 | recovery-ledger-2 | baseline | 1 | durable receipt；side effect occurred once |
| tier-2 | recovery-ledger-1 | v2 | 2 | 已停止 |
| tier-2 | recovery-ledger-2 | baseline | 3 | durable receipt；side effect occurred once |
| tier-2 | recovery-ledger-2 | reference | 3 | durable receipt；side effect occurred once |
| tier-2 | recovery-ledger-2 | v2 | 1 | 已停止 |
| tier-2 | recovery-ledger-3 | baseline | 1 | durable receipt；side effect occurred once |
| tier-2 | recovery-ledger-3 | baseline | 2 | durable receipt；side effect occurred once |
| tier-2 | recovery-ledger-2 | v2 | 3 | 已停止 |
| tier-2 | recovery-ledger-3 | v2 | 1 | 已停止 |
| tier-2 | recovery-ledger-4 | baseline | 1 | durable receipt；side effect occurred once；interrupted and resumed from persisted checkpoint |
| tier-2 | recovery-ledger-3 | baseline | 3 | durable receipt；side effect occurred once |
| tier-2 | recovery-ledger-3 | v2 | 3 | 本任务已达到轮数上限（30 轮）——已完成的工作已保存在会话中，可继续发送消息推进，或将任务拆小；长任务可调高 agent.maxTurns 配置 |
| tier-2 | recovery-ledger-4 | baseline | 2 | durable receipt；side effect occurred once |
| tier-2 | recovery-ledger-4 | baseline | 3 | durable receipt；side effect occurred once |
| tier-2 | recovery-ledger-4 | v2 | 2 | 已停止 |
| tier-2 | recovery-ledger-5 | baseline | 1 | durable receipt；side effect occurred once |
| tier-2 | recovery-ledger-5 | baseline | 2 | durable receipt |
| tier-2 | recovery-ledger-5 | v2 | 1 | 已停止 |
| tier-2 | recovery-ledger-5 | baseline | 3 | durable receipt；side effect occurred once |
| tier-2 | recovery-ledger-5 | v2 | 2 | 已停止 |
| tier-2 | recovery-ledger-5 | reference | 3 | The operation was aborted due to timeout |
| tier-2 | recovery-ledger-5 | v2 | 3 | 已停止 |
| tier-2 | recovery-ledger-6 | baseline | 1 | durable receipt；side effect occurred once |
| tier-2 | recovery-ledger-6 | baseline | 2 | durable receipt；side effect occurred once |
| tier-2 | recovery-ledger-6 | baseline | 3 | durable receipt；side effect occurred once |
| tier-2 | recovery-ledger-6 | reference | 3 | durable receipt；side effect occurred once |
| tier-2 | recovery-ledger-6 | v2 | 2 | 已停止 |
| tier-2 | recovery-ledger-6 | v2 | 3 | 已停止 |
| tier-2 | tool-failure-transient-read | reference | 1 | The operation was aborted due to timeout |
| tier-2 | tool-failure-transient-read | reference | 3 | recovered value；artifact updated after fault |
| tier-2 | tool-failure-missing-path | v2 | 1 | recovered value；artifact updated after fault |
| tier-2 | tool-failure-version-conflict | reference | 1 | The operation was aborted due to timeout |
| tier-2 | tool-failure-version-conflict | v2 | 1 | 已停止 |
| tier-2 | tool-failure-version-conflict | v2 | 2 | recovered value；artifact updated after fault；fault exercised |
| tier-2 | tool-failure-version-conflict | reference | 3 | recovered value；artifact updated after fault；fault exercised |
| tier-2 | tool-failure-truncated-read | reference | 2 | recovered value；artifact updated after fault |
| tier-2 | tool-failure-truncated-read | baseline | 3 | recovered value；artifact updated after fault |
| tier-2 | tool-failure-truncated-read | v2 | 2 | recovered value；artifact updated after fault |
| tier-2 | tool-failure-truncated-read | v2 | 3 | 已停止 |
| tier-2 | tool-failure-invalid-json | baseline | 3 | recovered value；artifact updated after fault |
| tier-2 | tool-failure-invalid-json | v2 | 2 | 已停止 |
