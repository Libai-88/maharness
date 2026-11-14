# maharness v2 真实任务对照评测

发布验收：未通过。完成样本 540/540。

评分使用 scored-samples.jsonl；原始执行记录保留在 samples.jsonl。评分修订依据保存在 scoring-audit.json，产物快照保存在 artifact-evidence.jsonl。JSON 对象按内容比较，键顺序不影响结果；模型请求和登记操作未重放。

完整 540 样本评测对应 1f11902；最终运行源码 1d9473c 的角色委派超时补丁仅有独立确定性及混合真实回归，未重跑完整性能矩阵。三组共享文件工具、材料和读写授权；baseline 使用归档 Kernel/AgentRunner 与 JSON 断点，reference/v2 使用 RunService 与 SQLite，服务封装和输入组装不同。

三组使用一致的任务材料、工具和模型请求参数。baseline 加载归档运行时，reference 使用最小循环，v2 使用持久任务服务与当前循环。恢复任务从持久断点继续，产物由文件及可执行断言核对。

| 模型请求标识 | 组别 | 成功数 / 样本数 | 成功率 | 模型调用中位数 | 输入 / 输出 token 中位数 |
| --- | --- | --- | --- | --- | --- |
| group/never-stuck | baseline | 89 / 90 | 98.9% | 5 | 12872 / 1072 |
| group/never-stuck | reference | 90 / 90 | 100.0% | 5 | 11118 / 917.5 |
| group/never-stuck | v2 | 87 / 90 | 96.7% | 6 | 18125 / 1099 |
| workbuddy/hy4free | baseline | 85 / 90 | 94.4% | 5 | 12571.5 / 964 |
| workbuddy/hy4free | reference | 83 / 90 | 92.2% | 5 | 11305 / 911 |
| workbuddy/hy4free | v2 | 82 / 90 | 91.1% | 6 | 18824 / 1412.5 |

## 分类结果

| 模型档 | 分类 | 组别 | 成功 / 样本 |
| --- | --- | --- | --- |
| route-1 | code | baseline | 17 / 18 |
| route-1 | code | reference | 18 / 18 |
| route-1 | code | v2 | 16 / 18 |
| route-1 | research | baseline | 18 / 18 |
| route-1 | research | reference | 18 / 18 |
| route-1 | research | v2 | 18 / 18 |
| route-1 | document | baseline | 18 / 18 |
| route-1 | document | reference | 18 / 18 |
| route-1 | document | v2 | 17 / 18 |
| route-1 | recovery | baseline | 18 / 18 |
| route-1 | recovery | reference | 18 / 18 |
| route-1 | recovery | v2 | 18 / 18 |
| route-1 | tool-failure | baseline | 18 / 18 |
| route-1 | tool-failure | reference | 18 / 18 |
| route-1 | tool-failure | v2 | 18 / 18 |
| route-2 | code | baseline | 17 / 18 |
| route-2 | code | reference | 15 / 18 |
| route-2 | code | v2 | 17 / 18 |
| route-2 | research | baseline | 18 / 18 |
| route-2 | research | reference | 17 / 18 |
| route-2 | research | v2 | 16 / 18 |
| route-2 | document | baseline | 17 / 18 |
| route-2 | document | reference | 16 / 18 |
| route-2 | document | v2 | 18 / 18 |
| route-2 | recovery | baseline | 17 / 18 |
| route-2 | recovery | reference | 17 / 18 |
| route-2 | recovery | v2 | 17 / 18 |
| route-2 | tool-failure | baseline | 16 / 18 |
| route-2 | tool-failure | reference | 18 / 18 |
| route-2 | tool-failure | v2 | 14 / 18 |

## 发布门禁

| 检查 | 结果 | 依据 |
| --- | --- | --- |
| matrix | 通过 | 540 samples |
| performance-revision | 未通过 | 完整 540 样本评测对应 1f11902；最终运行源码 1d9473c 的角色委派超时补丁仅有独立确定性及混合真实回归，未重跑完整性能矩阵。三组共享文件工具、材料和读写授权；baseline 使用归档 Kernel/AgentRunner 与 JSON 断点，reference/v2 使用 RunService 与 SQLite，服务封装和输入组装不同。 |
| model-identity | 未通过 | Every call must match the fixed model version; route names alone are insufficient |
| reference-success:route-1 | 通过 | Maximum success-rate decline: 5 percentage points |
| baseline-success:route-1 | 未通过 | Success rate must meet the old baseline |
| cost:route-1 | 无法确认 | Maximum median cost increase: 15%; zero-price or missing-cost samples cannot measure a percentage increase |
| confirmations:route-1 | 通过 | Unnecessary confirmations must not increase |
| reference-success:route-2 | 通过 | Maximum success-rate decline: 5 percentage points |
| baseline-success:route-2 | 未通过 | Success rate must meet the old baseline |
| cost:route-2 | 无法确认 | Maximum median cost increase: 15%; zero-price or missing-cost samples cannot measure a percentage increase |
| confirmations:route-2 | 通过 | Unnecessary confirmations must not increase |
| duplicateEffects | 通过 | No observed violations |
| permissionViolations | 通过 | No observed violations |
| eventGaps | 通过 | No observed violations |
| validation:typecheck | 通过 | ../composition-validation-20261115/postfix-typecheck.log |
| validation:unit | 通过 | ../composition-validation-20261115/postfix-unit.log |
| validation:security | 通过 | ../composition-validation-20261115/postfix-security.log |
| validation:build | 通过 | ../composition-validation-20261115/postfix-build.log |
| validation:desktop | 通过 | ../composition-validation-20261115/postfix-browser.log |
| validation:narrow-screen | 通过 | ../composition-validation-20261115/postfix-browser.log |
| validation:accessibility | 通过 | ../composition-validation-20261115/postfix-browser.log |
| validation:reconnect | 通过 | ../composition-validation-20261115/postfix-browser.log |
| validation:migration-rollback | 通过 | ../composition-validation-20261115/postfix-unit.log |
| validation:plugin-contract | 通过 | ../composition-validation-20261115/postfix-security.log |

## 证据边界

模型身份来自网关原始响应；仅返回路由别名时，报告不认定固定底层版本。免费模型的真实账单为零，无法以零为分母判断 15% 费用增幅；调用与 token 单独列出。

模型请求次数：3108；报告输入 token：9150254；报告输出 token：756800。

usage 完整样本：519/540。缺失 usage 的请求不记为已知 token 成本。

重复副作用统计限于登记订单场景。权限和事件安全结论同时依赖确定性安全、恢复及租户测试。研究任务使用固定本地材料，结果不能外推为开放网络检索质量。运行参数、原始样本、模型响应身份与工具记录分别保存在 manifest.json 和 samples.jsonl。

## 未通过样本

| 模型档 | 任务 | 组别 | 次数 | 失败依据 |
| --- | --- | --- | --- | --- |
| route-2 | document-translation | baseline | 1 | document artifact requirements |
| route-2 | code-unique | reference | 1 | executable code assertions |
| route-2 | code-unique | reference | 2 | executable code assertions |
| route-2 | tool-failure-transient-read | baseline | 2 | recovered value；artifact updated after fault |
| route-2 | code-group | baseline | 2 | executable code assertions |
| route-2 | tool-failure-truncated-read | baseline | 3 | recovered value；artifact updated after fault |
| route-2 | research-source-1 | v2 | 3 | latest audited source and provenance |
| route-2 | research-source-3 | v2 | 2 | latest audited source and provenance |
| route-2 | tool-failure-version-conflict | v2 | 3 | fault exercised；recovered value；artifact updated after fault |
| route-2 | code-unique | v2 | 3 | LLM 流异常中断 [eval-55ba6893-f521-4c26-8f51-2794bd291fc0]：连接已关闭但未收到 [DONE] 结束标记 |
| route-2 | tool-failure-invalid-json | v2 | 2 | recovered value；artifact updated after fault |
| route-2 | document-structured | reference | 2 | document artifact requirements |
| route-2 | research-source-5 | reference | 2 | latest audited source and provenance |
| route-2 | recovery-ledger-1 | v2 | 2 | durable receipt；side effect occurred once |
| route-2 | tool-failure-schema-read | v2 | 1 | LLM 请求失败 [eval-a446531e-adbd-4653-95f6-31796c4c29b5] 400: {"error":{"code":null,"message":"WorkBuddy: Invalid request parameters","param":null,"type":"invalid_request_error"}}  |
| route-1 | code-median | baseline | 1 | 第 1 处编辑未找到匹配文本（文件未改动） |
| route-1 | document-structured | v2 | 3 | EVAL_TOKEN_LIMIT |
| route-1 | code-slug | v2 | 1 | EVAL_TOKEN_LIMIT |
| route-2 | recovery-ledger-3 | baseline | 1 | durable receipt；side effect occurred once |
| route-1 | code-unique | v2 | 1 | LLM 请求失败 [eval-399079a6-71c1-4006-bdad-227dc80ca25c] 400: {"error":{"code":null,"message":"WorkBuddy: Invalid request parameters","param":null,"type":"invalid_request_error"}}  |
| route-2 | tool-failure-version-conflict | v2 | 2 | fault exercised；recovered value；artifact updated after fault |
| route-2 | recovery-ledger-6 | reference | 3 | durable receipt；side effect occurred once |
| route-2 | code-median | reference | 2 | executable code assertions |
| route-2 | document-translation | reference | 3 | document artifact requirements |
