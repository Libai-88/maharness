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

## [0.1.0]

### Added

- 初始发布：薄内核 + 插件化 Agent + 网页面板 + 轨迹观测。
