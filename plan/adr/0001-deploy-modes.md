# ADR 0001：local/trusted/remote 三部署模式与启动安全自检

状态：accepted（2026-11-01）

## 背景

原有部署只有单一本机形态：回环绑定 + 变更类请求可选 token。两类真实需求无法满足——本机存在不可信进程时需要全 API 收紧；对外暴露（局域网/远程）需要强制 TLS 与凭据，否则服务以弱配置跑在公网。

## 决策

以 `MAHARNESS_MODE` 显式声明三种部署模式（缺省 local，向后兼容）：`local` 保持既有本机语义；`trusted` 仍绑回环但全 API（含 GET/SSE）强制 token 且审批凭据自动强制；`remote` 必须同时具备 token 与成对 TLS 证书/私钥，绑定 `MAHARNESS_BIND`，缺任一前置启动自检 fail-closed 拒绝启动。配置非法时输出错误清单并终止进程，不静默降级为弱配置。

## 后果

- remote 模式只解决传输与凭据层；插件仍在宿主进程执行（威胁模型 v1.1 剩余风险），不等价于多租户隔离。
- `createApiTokenGuard` 从逐请求读 env 扩展为「env + 部署模式」双因子；local 门关闭 = 完全放行的既有语义保留。
- 审批凭据强制从环境开关扩展为模式自动强制（trusted/remote）。

## 回滚

还原 `server/deploy-mode.ts` 接线与 guard 双因子逻辑，恢复单模式（回环 + 可选 token）行为；配置了 remote/trusted 的部署需先回退代码再调整 env。
