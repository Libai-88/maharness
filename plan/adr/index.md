# 架构决策记录（ADR）索引

重大契约改动（API schema、数据库 schema、插件 manifest、部署模式、凭据策略）在实施前登记 ADR；每条记录背景、决策、后果与回滚方式。ADR 文件名格式 `NNNN-<标题>.md`，从 0001 递增，不接受删除——被取代的 ADR 标记 `superseded by NNNN`。

| 编号 | 标题 | 状态 |
|---|---|---|
| [0001](0001-deploy-modes.md) | local/trusted/remote 三部署模式与启动安全自检 | accepted |
| [0002](0002-host-service-boundary.md) | Host Service 与 Plugin 的边界 | accepted |
| [0003](0003-social-observations.md) | 社会健康改为观察指标 | accepted |
| [0004](0004-database-migration-v16.md) | 数据库 v16 与不可变迁移 | accepted |
| [0005](0005-experience-review-v2.md) | Experience Review v2 与真实模型验收 | accepted |
| [0006](0006-kernel-scope.md) | 内核边界判据：机制与契约，不放产品能力 | accepted |
| [0007](0007-deployment-envelope.md) | 部署定位与扩展路径（单机单库 + 三条升级触发） | accepted |
| [0008](0008-run-engine-layering.md) | Run 引擎分层：journal/state/ledger/recovery/executor | accepted |
| [0009](0009-contract-single-source.md) | 契约单一来源与前端类型生成 | accepted |
| [0010](0010-routes-to-usecases.md) | 路由只做协议，编排下沉 usecases | accepted |
| [0011](0011-complexity-budget.md) | 热点度量改用复杂度预算（基线只降不升） | accepted |

与本文关联的既有权威文档：威胁模型 [threat-model-v1.md](../threat-model-v1.md)、版本与兼容策略 [release-policy-v1.md](../release-policy-v1.md)、插件 manifest 兼容 [manifest-v1-compatibility.md](../manifest-v1-compatibility.md)、API 契约 [api-contract-v1.md](../api-contract-v1.md)、供应链策略 [supply-chain-policy-v1.md](../supply-chain-policy-v1.md)。
