# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本号与 `web-agent/package.json` 一致。

## [Unreleased]

### Added

- 数据库 schema 版本化迁移（`PRAGMA user_version`）+ 启动备份/完整性校验/自动恢复（API-04）。
- HTTP API schema v1 契约登记与运行时校验（API-01）。
- 插件 manifest API 兼容范围与能力权限声明（SEC-04 / PL-01）。
- 确定性 eval 门禁与质量率阈值（QA-03）。
- SSRF 连接 pinning（SEC-02）、SSE 生命周期审计与配额（SEC-03 / API-03）。
- 长任务取消传播审计面 `/api/ready resources`（LR-05）。
- Provider 诊断端点与多协议探测（MD-06）。
- 文件缓存外部变更指纹（CT-06）。
- 可访问性 axe-core 门禁（UX-05）。
- 从零开发环境文档 `web-agent/docs/DEVELOPMENT.md`（DX-01）。
- 版本/迁移/兼容策略 `plan/release-policy-v1.md`（DX-03）。
- 部署模式 local/trusted/remote 与启动安全自检（API-02）。
- Windows 运维手册：安装、升级、恢复、数据目录、密钥异常、remote 暴露前置与回滚（API-08）。
- 供应链策略文档 `plan/supply-chain-policy-v1.md`：npm/技能包/插件三类对象的哈希锚定、升级与回滚路径（SEC-07）。
- 插件 SDK 公共边界：core/plugins 源码统一从 `kernel/plugin-sdk` 导入，新增依赖边界测试与 `npm run check:boundaries` / `check:quality`。
- 社会制度新增 `roleSelectionWeights` 六因子权重版本；任务支持显式 `requiredCapabilities` / `needsWrite`，社会健康快照附带 `scoreKind`、`sampleSize` 与权重说明。
- `npm run test:coverage` 可选的 Node 原生覆盖率入口；数据库迁移连续性门禁测试。

### Changed

- 对话、个人事项与自动化共用 Run 执行链，返工关联原工作单并保留历史交付。
- 工作台聚焦个人事务；独立 AI 社会页面提供角色、分支、交付和异常观察，以及补充要求、停止、恢复、审批与返工。
- 普通任务支持预算缺省与未知价格，显式预算仍然生效；基础观察工具直接可用，其他工具按任务与阶段加载。
- 清理过时的规划文档与历史评测报告目录，文档引用统一指向现行开发与验收入口；重新生成插件锁，恢复 workbench 源码完整性校验。
- `OrganizationService` / `SocietyService` 注入可测试时钟；角色选择权重进入制度版本；`society` 政策常量与校验拆到 `server/society-policy.ts`，角色选择评分拆到 `server/society-selection.ts`，热点路径复用单个 `OrganizationService`。
- 社会健康指标从等权展示改为显式 `weighted_heuristic`，UI 标注“社会健康（启发式）”，避免把启发式分数当成客观测量。

### Fixed

- 完成状态核对有效答复、必交产物与契约验收，缺项和失败保留可检查的部分成果。
- 契约产物按父任务与角色权限收窄写入，执行时复检路径；暂停、重启和恢复复用已确认副作用。
- 工具结果采用 8,000 字符内联边界，模型输出与上下文预算统一，调用用量去重并保留未知费用。
- CI 的 golden 回归改用 `evals/replay-v2-baseline.json`，与本地 `eval:ci` 使用同一基线，修复旧基线造成的假回归。

### Security

- body-parser、proxy-addr、qs、undici 与 DOMPurify 的安全修复已纳入依赖锁（SEC-07）。当前生产依赖审计与发布门禁见 `web-agent/evals/acceptance/optimization-closeout/summary.json`。
- 生产依赖审计清零：`exceljs` 的 `uuid` 固定到 11.1.1，`pptxgenjs` 的 `image-size` 固定到 2.1.0；前端将 `shadcn` CLI 移入 devDependencies。`npm audit --omit=dev` 在前后端均报告 0 漏洞。

## [0.1.0]

### Added

- 初始发布：薄内核 + 插件化 Agent + 网页面板 + 轨迹观测。
