# 架构决策记录（ADR）索引

重大契约改动（API schema、数据库 schema、插件 manifest、部署模式、凭据策略）在实施前登记 ADR；每条记录背景、决策、后果与回滚方式。ADR 文件名格式 `NNNN-<标题>.md`，从 0001 递增，不接受删除——被取代的 ADR 标记 `superseded by NNNN`。

| 编号 | 标题 | 状态 |
|---|---|---|
| [0001](0001-deploy-modes.md) | local/trusted/remote 三部署模式与启动安全自检 | accepted |

与本文关联的既有权威文档：威胁模型 [threat-model-v1.md](../threat-model-v1.md)、版本与兼容策略 [release-policy-v1.md](../release-policy-v1.md)、插件 manifest 兼容 [manifest-v1-compatibility.md](../manifest-v1-compatibility.md)、API 契约 [api-contract-v1.md](../api-contract-v1.md)、供应链策略 [supply-chain-policy-v1.md](../supply-chain-policy-v1.md)。
