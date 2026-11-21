# ADR 0005：Experience Review v2 与真实模型验收

## 背景

当前复盘让任务模型自评，使用 10 维长 JSON、800/1,200 token 输出上限和固定九类合成 fixture；真实模型复测 `group/never-stuck` 为 1/9、`auto/deepseek-v4.1-flash` 为 5/9。高 reasoning 路由耗尽输出预算，剩余失败混合了 fixture 过弱、关键词断言过严和真实语义分歧。

## 决策

1. 复盘必须指定独立 reviewer（`providerId` + `model` 或 `review.providerId/model` 配置）；未指定返回 `REVIEW_MODEL_REQUIRED`，不再默认自评。
2. 保留两阶段：先选择证据引用和缺口，再输出紧凑评分 JSON；提示词不重复长说明。
3. reasoning 模型继续使用总预算余量作为输出上限；高 reasoning 路由（`group/never-stuck`）只做压力测试，不作为发布门禁。
4. 新建 `evals/experience-v2`：20 条真实工具事实 fixture，人工标注裁决；指标为格式通过率、裁决一致率、证据有效率、建议可采纳率，不再用 `expectedText` 关键词正则决定通过。
5. 发布门禁使用稳定、可关闭 reasoning 的模型；报告必须记录模型、reasoning、预算、调用数、token 与原始报告 hash。

## 后果

- 破坏 `POST /api/experience/reviews` 的默认自评行为；API v2 和 UI 设置同步更新。
- 真实模型结果不再被包装成单一通过率；1/9 或 5/9 只作为诊断，不直接支撑发布。
- 复盘成本和模型选择更显式，长期质量更容易比较。