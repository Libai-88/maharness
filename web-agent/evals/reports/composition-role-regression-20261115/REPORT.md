# 角色委派超时回归

日期：2026-11-15。运行源码：`1d9473c`。类型：确定性父代理与真实子模型的混合回归。

完整断言通过 5/6；角色调用跨过普通工具期限并成功返回 6/6。源码指纹对应当前运行源码。

父代理固定调用创建、启用和角色入口，不向网关发送请求；子代理使用配置的真实路由。每个子代理首次请求前等待 35 秒，普通工具期限 30 秒，角色入口期限 240 秒，执行槽位为 1。每样本最多 4 次物理请求，单次输出最多 512 token。

| 路由 | 重复 | 调用耗时（毫秒） | 子任务状态 | 子任务答案 | 完整断言 |
| --- | --- | --- | --- | --- | --- |
| group/never-stuck | 1 | 41439 | completed | 12 | 通过 |
| group/never-stuck | 2 | 39238 | completed | 12 | 通过 |
| group/never-stuck | 3 | 38420 | completed | 12 | 通过 |
| workbuddy/hy4free | 1 | 38251 | completed | 12 | 通过 |
| workbuddy/hy4free | 2 | 38357 | completed | 12 | 通过 |
| workbuddy/hy4free | 3 | 55149 | completed | （空） | 未通过 |

共 7 次真实网关请求；保守计账 11,939 token。失败样本原样保留，没有重跑替换。

超时与单槽位调度断言全部通过；一个子模型返回空答案，使完整结果断言未通过。该回归不衡量模型自主设计插件的能力，不能替代完整专项或性能门禁。

运行参数与版本见 [manifest.json](manifest.json)，原始断言见 [samples.jsonl](samples.jsonl)，汇总见 [report.json](report.json)，复现脚本见 [role-live.ts](role-live.ts)。
