# maharness 插件组合真实评测

日期：2026-11-15。完整矩阵：144/144。评测版本：`1f11902`。基线版本：`058c363`。归档源码指纹对应评测版本；最终代码的角色委派超时补丁另有确定性与混合真实回归证据，本矩阵不代表补丁后的完整性能复测。

| 路由 | 组别 | 通过 / 样本 | 成功率 | usage 完整样本 |
| --- | --- | --- | --- | --- |
| group/never-stuck | baseline | 0 / 36 | 0.0% | 24 / 36 |
| group/never-stuck | v2 | 22 / 36 | 61.1% | 31 / 36 |
| workbuddy/hy4free | baseline | 0 / 36 | 0.0% | 2 / 36 |
| workbuddy/hy4free | v2 | 19 / 36 | 52.8% | 19 / 36 |

## 任务结果

| 任务 | group/never-stuck baseline | group/never-stuck v2 | workbuddy/hy4free baseline | workbuddy/hy4free v2 |
| --- | --- | --- | --- | --- |
| pure-tool | 0 / 3 | 3 / 3 | 0 / 3 | 3 / 3 |
| multi-file | 0 / 3 | 2 / 3 | 0 / 3 | 3 / 3 |
| service-tool | 0 / 3 | 2 / 3 | 0 / 3 | 2 / 3 |
| context | 0 / 3 | 3 / 3 | 0 / 3 | 2 / 3 |
| event-listener | 0 / 3 | 1 / 3 | 0 / 3 | 0 / 3 |
| command | 0 / 3 | 1 / 3 | 0 / 3 | 0 / 3 |
| role | 0 / 3 | 0 / 3 | 0 / 3 | 0 / 3 |
| provider | 0 / 3 | 2 / 3 | 0 / 3 | 3 / 3 |
| api-panel | 0 / 3 | 2 / 3 | 0 / 3 | 2 / 3 |
| dependency | 0 / 3 | 1 / 3 | 0 / 3 | 1 / 3 |
| failed-upgrade | 0 / 3 | 3 / 3 | 0 / 3 | 3 / 3 |
| release-resources | 0 / 3 | 2 / 3 | 0 / 3 | 0 / 3 |

## 执行证据

原始断言通过 41 个样本；执行顺序复核通过 41 个。命令、Provider、依赖调用核对成功工具回执；失败升级核对旧版本激活、候选失败和随后成功调用的先后关系；资源释放核对显式停用、释放事件与随后状态读取。复核不重放模型或工具调用。

请求数：875；HTTP 错误回执：5；缺少完整 usage 的请求：68；含运行错误的样本：49。这些观察可重叠，不作为互斥的失败归因。

保守 token 计账：5,627,132。usage 缺失或响应不确定的请求保留预留量；已回传用量与保守计账不混为同一指标。

## 证据边界

成功要求任务执行结束且所有原始断言通过。基线缺少新的任务插件契约；本矩阵比较自扩展入口的实际功能，不能解释为相同工具能力下的纯循环性能差异。persona 未单独进入真实专项，其注册与释放由确定性测试覆盖。

路由名称不证明固定底层模型版本；免费账单不能验证非零费用的百分比增幅。专项结果不能单独批准发布。

原始样本见 [samples.jsonl](samples.jsonl)，失败断言见 [report.json](report.json)，执行参数见 [manifest.json](manifest.json)，源码指纹见 [evaluated-sources.json](evaluated-sources.json)，完整预算与配对审计见 [final-audit.json](../composition-validation-20261115/final-audit.json)。
