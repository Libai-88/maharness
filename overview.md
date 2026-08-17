# maharness 系统性审查 — Overview

## 做了什么
对 maharness（`D:\DEEPSEEK\web-agent`）做了全量源码级审查，对照 Cordis（`D:\DEEPSEEK\cordis-main`）核心机制逐项比对，并核对《maharness 核心框架升级》设计文档的兑现情况。

## 核心结论
- **设计文档四大方向 + 缓存优化全部落地，无欠账**（依赖驱动智能重载 / 五语义事件总线 / 服务级调用追踪 / 上下文配置合并 / warmup 三态与 promptKey 优化均已实现，typecheck 通过）。
- **已确立优势**：事务性热重载（含回滚）、四维依赖签名（service+capability+config+requires，比 Cordis 的 inject-epoch 覆盖面广）、显式调用追踪、事件中间件兼容旧监听器。
- **三个结构性短板**：
  1. **零自动化测试**（P0）——Cordis 有 15+ spec，maharness 仅有冒烟脚本；五语义事件/逆元栈/事务回滚等高风险机制无回归保护。
  2. **`.env` 热更新实际失效**（P0）——depSignature 无 env 分量，且 search 插件把 API key 放在模块顶层常量 + ESM 缓存导致 reload 也拿不到新值。
  3. **配置无 schema 校验 + 无上下文隔离域**（P1）——语义模型比 Cordis 薄，属取舍但需知晓。

## 修复执行（2026-08-17，Phase 1-3 全部完成）
- **P0/B1 env 热更新**：watchEnv/bumpEnv 链路（server .env diff → bumpEnv → reloadChanged）+ search 插件惰性化。
- **P0/B2 零测试**：`kernel/tests/` 40 个单测全绿（bus 19 / scope 8 / loader 13，node:test 零新依赖）。
- **Phase 2**：配置 schema（manifest.config + validate.ts 校验，不合规注册失败/回滚/error 态）；B6 config.changed → 400ms 防抖 reloadChanged。
- **Phase 3**：类型化事件表（KernelEvents + bus keyof overload）；Service 抽象基类（kernel/service.ts，构造即注册）。
- **B9 tsx hash busting 失效**：缓解完成——reload 内容变化警告 + plugin-authoring 契约（onLoad 内读配置、不做顶层常量）；切原生 TS/代理文件两方案经评估不可行（见报告 §8.2）；**隔离域评估后不实施**（configWith 已覆盖上下文配置差异，§8.2b）。

## 交付物
- `D:\DEEPSEEK\maharness-审查报告.md` — 完整审查报告（兑现度核对表 / 差距矩阵 G1-G8 / 缺陷清单 B1-B9 / 修复记录 / 路线图全部勾选）

## 验证
typecheck 0 error；`npm test` 40/40；selftest 断言通过。遗留：selftest 的 Windows trash 清理报错为环境噪音；插件文件内容维度热重载在 tsx 下需重启（契约已文档化）。
