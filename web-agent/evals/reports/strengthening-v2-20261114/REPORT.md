# maharness 补强评测

日期：2026-11-14。工程目标：未通过。发布状态：未通过。

样本名额 60/60，有效 50，夹具无效 10。原始 32 条记录的 SHA-256 校验通过；2 个中止名额保留，未补跑。

指标覆盖评测时的运行时快照。最终源码包含批次断点修复，尚无对应真实模型复测；最终版本的性能覆盖为未确认。质量及恢复对照因无效样本和夹具修正记为未知。

| 线路 | 组别 | 成功 / 有效样本 | 无效 | 恢复成功 / 有效样本 | 调用中位数 |
| --- | --- | --- | --- | --- | --- |
| group/never-stuck | baseline | 3/9 | 1 | 0/3 | 2 |
| group/never-stuck | reference | 7/9 | 1 | 3/3 | 5 |
| group/never-stuck | v2 | 4/7 | 3 | 0/1 | 5 |
| workbuddy/hy4free | baseline | 5/7 | 3 | 0/1 | 4 |
| workbuddy/hy4free | reference | 10/10 | 0 | 4/4 | 5 |
| workbuddy/hy4free | v2 | 4/8 | 2 | 0/2 | 5.5 |

## 配对开销

只统计双方产物通过且 usage 完整的有效配对，不能代表全任务开销。
- group/never-stuck：3 对；参考 / v2 输入 tokens 中位数 12190 / 12215；调用中位数 5 / 5。
- workbuddy/hy4free：4 对；参考 / v2 输入 tokens 中位数 11880.5 / 11958.5；调用中位数 4.5 / 4.5。

## 有效失败样本

| 线路 | 任务 | 组别 | 断言或错误 |
| --- | --- | --- | --- |
| group/never-stuck | research-source-1 | reference | latest audited source and provenance |
| group/never-stuck | research-source-1 | v2 | latest audited source and provenance |
| workbuddy/hy4free | research-source-1 | v2 | latest audited source and provenance |
| group/never-stuck | recovery-after-append | baseline | durable receipt; side effect occurred once; interrupted and resumed from persisted checkpoint |
| group/never-stuck | recovery-long-result | baseline | tail observation recovered; interrupted and resumed from persisted checkpoint |
| group/never-stuck | recovery-supplement | baseline | durable receipt; side effect occurred once; supplement preserved |
| group/never-stuck | recovery-supplement | v2 | durable tool results |
| workbuddy/hy4free | recovery-long-result | v2 | tail observation recovered |
| workbuddy/hy4free | recovery-supplement | baseline | durable receipt; side effect occurred once; supplement preserved |
| workbuddy/hy4free | recovery-supplement | v2 | durable tool results |
| group/never-stuck | tool-failure-schema-read | baseline | recovered value; artifact updated after fault |
| group/never-stuck | tool-failure-version-conflict | baseline | recovered value; artifact updated after fault; fault exercised |
| group/never-stuck | tool-failure-version-conflict | reference | recovered value; artifact updated after fault; fault exercised |
| group/never-stuck | tool-failure-truncated-read | baseline | recovered value; artifact updated after fault |
| group/never-stuck | tool-failure-truncated-read | v2 | recovered value; artifact updated after fault |
| workbuddy/hy4free | tool-failure-truncated-read | baseline | recovered value; artifact updated after fault |
| workbuddy/hy4free | tool-failure-truncated-read | v2 | recovered value; artifact updated after fault |

## 夹具无效样本

| 线路 | 任务 | 组别 | 错误 |
| --- | --- | --- | --- |
| group/never-stuck | recovery-after-read | baseline | EVAL_CHECKPOINT_INTERRUPT |
| group/never-stuck | recovery-after-read | v2 | EVAL_CHECKPOINT_INTERRUPT |
| workbuddy/hy4free | recovery-after-read | v2 | EVAL_CHECKPOINT_INTERRUPT |
| workbuddy/hy4free | recovery-after-read | baseline | EVAL_CHECKPOINT_INTERRUPT |
| workbuddy/hy4free | recovery-after-append | v2 | EVAL_CHECKPOINT_INTERRUPT |
| group/never-stuck | recovery-after-append | v2 | EVAL_CHECKPOINT_INTERRUPT |
| workbuddy/hy4free | recovery-after-append | baseline | EVAL_CHECKPOINT_INTERRUPT |
| group/never-stuck | recovery-long-result | v2 | EVAL_CHECKPOINT_INTERRUPT |
| group/never-stuck | recovery-long-result | reference | EVAL_HARNESS_ABORT_RECEIPTS_UNKNOWN |
| workbuddy/hy4free | recovery-long-result | baseline | EVAL_HARNESS_ABORT_RECEIPTS_UNKNOWN |

## 预算与证据范围

预算计账 958,987 / 1,000,000 tokens，无未结算预留。已保存 usage 合计 852,611 tokens；差额 106,376 包括中止工作项的保守计账，不能当作实际用量。已保存请求回执 264 个，中止项的请求次数与完整实际用量未知。

每样本最多 12 次 HTTP 请求、每次最多 1024 输出 tokens、120 秒时限；并发为 2。两条线路均按用户明确确认的免费线路计账，不能据此计算美元费用增幅或确认底层模型版本、能力档位。

观察到目标工具成功后，在下一断点回调触发中断；该边界可能位于同批次下一工具执行前。恢复重建数据库连接与 RunService，不等同于进程退出。有效记录未观察到重复登记或事件序号缺口，权限验证仅由确定性测试提供。

无效样本保留全部原始结果，不计为框架或模型失败。各组有效样本数量不同，不能直接比较表中比率。专项评测不替代 540 样本发布门禁。

## 证据文件

- [原始样本](samples.jsonl)
- [机器可读报告](report.json)
- [评测结束时报告](report-evaluated.json)
- [最终源码校验](final-source-audit.json)
- [续测审计](continuation-audit.json)
- [评测源码快照](evaluated-sources-continuation.json)
