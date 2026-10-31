# maharness 威胁模型 v1

版本：1.0
核对日期：2026-10-30
适用范围：当前 `web-agent` 单机本地部署

## 系统边界

maharness 由本机 HTTP 服务、浏览器 UI、Agent 内核、插件、工作区文件、SQLite 数据库、Trace 归档及外部 Provider/MCP/HTTP 目标组成。默认服务只绑定回环地址，产品当前按单机单用户设计。

信任边界包括：浏览器到本机 HTTP 服务、Agent 到工作区和操作系统进程、内核到插件、服务端到 Provider/MCP/任意 URL、服务端到本地密钥与持久化数据。

## 资产

| 资产 | 影响 |
|---|---|
| Provider/API 凭据、主密钥 | 模型账户被滥用、历史密文不可恢复 |
| 工作区文件及用户目录 | 数据泄露、覆盖或删除 |
| Agent 审批策略、沙箱根和 Provider 配置 | 工具权限扩大、行为被改变 |
| MCP 子进程及继承环境 | 凭据泄露、宿主资源滥用 |
| 本机 HTTP 控制面与审批凭据 | 未授权修改配置或批准高风险操作 |
| 会话、任务 checkpoint、Trace | 对话与执行证据泄露、审计缺失 |

## 攻击者与假设

| 攻击者 | 能力假设 |
|---|---|
| 恶意网页 | 可诱导用户访问页面并尝试向本机服务发请求；不能直接读取本机进程内存 |
| 同机低信任进程 | 可访问回环端口；通常以相同 OS 用户身份运行 |
| 恶意提示、模型输出或工具输出 | 可尝试诱导越权工具调用、隐藏指令或错误报告 |
| 恶意/被攻陷插件 | 插件代码可执行任意宿主权限代码；当前实现不将其视为受隔离代码 |
| 恶意远端服务或 DNS 响应 | 可控制响应内容、重定向与解析结果 |

OS 管理员、已控制当前 OS 用户的攻击者和物理控制设备者不在应用层防护承诺内。相同 OS 用户可读取进程可访问的文件和环境，因此 API token 不是进程隔离边界。

## 入口与现有控制

| 入口 | 主要威胁 | 当前控制与证据 |
|---|---|---|
| HTTP/UI 控制面 | DNS rebinding、跨源请求、未授权配置变更 | 回环绑定及 Host/Origin 白名单；可选 `MAHARNESS_API_TOKEN` 保护变更方法。API mutation 与审批响应共用凭据决策函数；授权成功/拒绝及 `/api/events` SSE 生命周期发布脱敏事件，并写入 SQLite `authorization_audit`；`GET /api/security/audit` 对读取数量设上限。`server/tests/auth.spec.ts`、`server/tests/db.spec.ts` 覆盖决策、轮换、审计脱敏、SSE 清理、持久化与重启读取 |
| 高风险工具审批 | 伪造、重放审批 | 一次性审批凭据在强制模式下校验；缺失或无效凭据发布脱敏拒绝审计事件。`server/tests/auth.spec.ts` 覆盖缺失、错误、重放和超时 |
| 工作区与文件工具 | 路径越界、危险根目录登记 | workspace 注册和切换复检危险目录；文件操作受 sandbox 根约束。`server/tests/auth.spec.ts`、`kernel/tests/sandbox.spec.ts` 与对应工具测试覆盖边界 |
| PowerShell | 只读白名单绕过、参数位注入、副作用命令 | 语法子集判定与审批策略；`core/powershell/tests/approval-bypass.spec.ts` 覆盖脚本块、成员调用、表达式和误拦样本 |
| MCP stdio/HTTP | 凭据继承、危险调用、私网访问、子进程残留 | 默认最小化 spawn 环境、工具默认需审批、URL/私网校验、Windows 进程树回收；`core/mcp/tests/security.spec.ts` 覆盖对应纯逻辑边界 |
| Provider 与 `web_fetch` | SSRF、重定向绕过、超大响应 | `server/tests/providers.spec.ts` 覆盖 Provider 主机、协议和 DNS 入口；Provider 与 `web_fetch` 直连将同一次解析的已校验地址交给 socket connector。`server/tests/ssrf.spec.ts`、`core/search/tests/ssrf.spec.ts` 验证单次解析、实际连接使用固定地址、重定向逐跳 pinning、混合公网/私网答案 fail-closed 和响应体上限。`SEARCH_PROXY` 仅用于固定 DuckDuckGo/Tavily 服务地址，配置只接受无凭据的 HTTP(S) 代理 URL，变更时关闭旧 dispatcher；代理解析由用户配置的受信代理负责 |
| 插件加载 | 未声明 capability 登记、加载失败残留 | manifest 白名单校验、拒绝事件和失败效应回收；`kernel/tests/loader.spec.ts` 覆盖授权、拒绝和兼容模式 |
| 凭据存储 | 明文落库、主密钥损坏静默丢失 | Provider 密钥加密存储，异常状态诊断及显式重建/备份路径；`server/tests/auth.spec.ts` 覆盖密钥状态与失败行为 |
| Trace/任务数据 | 敏感参数入日志、跨会话数据暴露、归档增长 | Trace 过滤/脱敏需逐事件核对；归档按天写入并按保留期清理，归档读取限制日期文件与尾部行数 |

安全回归映射由 `web-agent/scripts/check-threat-model.mjs` 校验：威胁模型中的代码/测试路径必须存在，`test:security` 中的每个测试文件必须在模型中出现。CI 执行 `npm run check:threat-model`；入口维护角色为安全维护者，代码路径或安全测试集合变更时同步复核本文件。

## 复核节奏与集成级验证

- 版本化：安全边界、部署模式、插件执行器、凭据策略或新增暴露入口变更时递增本模型版本，并同步更新入口表、剩余风险表和测试映射。
- 例行复核：每次发布前核对入口表与剩余风险表；每季度对全部入口做一次控制有效性抽查（跑完整 `npm run test:security`、`npm run check:threat-model` 与主 CI）。
- 集成级验证：控制措施不只在单元层验证——`server/tests/auth.spec.ts` 覆盖真实 HTTP 请求的凭据决策、来源校验、SSE 配额与审计落库；`server/tests/provider-diagnostics.spec.ts` 覆盖真实聊天链路的审批批准/拒绝与工具执行；`server/tests/ssrf.spec.ts` 与 `core/search/tests/ssrf.spec.ts` 使用真实本地 HTTP connector 验证连接目标固定；UI E2E 覆盖浏览器侧审批批准/拒绝交互。上述全部纳入 GitHub Actions 主 CI 干净 checkout 执行。

## 已确认的剩余风险

| 风险 | 当前影响 | 发布要求 |
|---|---|---|
| 插件在宿主 Node 进程内执行，可访问 `ctx.kernel` 和 OS 用户权限 | 恶意插件可绕过 UI、提示词及 capability 登记白名单；白名单只约束 `ctx.register` | 远程/团队模式上线阻断。需独立 OS 身份、容器或虚拟机隔离，并通过逃逸测试 |
| 固定搜索服务经 `SEARCH_PROXY` 时由代理解析目标地址 | 本机无法验证代理实际连接的远端 IP；代理配置或代理解析器不可信时可能访问非预期目标 | 仅允许用户显式配置并信任无凭据的 HTTP(S) 代理；非法协议、凭据、查询参数和片段直接拒绝；任意用户提供 URL 不经代理，使用已验证 IP 直连；对代理端点与固定服务域名的信任需在部署策略中明确 |
| 默认无多用户/多租户身份和数据隔离 | 共享实例可能暴露会话、文件、审批和 Provider 配置 | 团队/共享部署阻断；先完成身份、授权、租户隔离和跨租户负向测试 |
| API token 与数据目录受同一 OS 用户权限控制 | 同用户恶意进程可读取 token 或直接改数据 | 仅作为意图确认门槛；不得作为本机恶意进程隔离承诺 |
| 长期 Trace/会话数据可能包含用户内容 | 本地磁盘、备份或诊断包泄露 | 明确保留/删除策略、导出脱敏和访问边界；完成逐字段审计 |

## 验证与治理

- 确定性安全回放入口：`npm run test:security`；评测攻击 case 入口：`npm run eval:ci`。
- 本地/单用户发布前执行主 CI、安全用例、密钥恢复演练和升级备份检查。
- 远程/团队发布前必须关闭插件进程隔离、身份/租户隔离及 SSRF TOCTOU 阻断项，并完成独立攻击回放。
- 安全边界、部署模式、插件执行器或敏感数据策略改变时递增本模型版本，并同步测试映射。

## 回滚与响应

安全策略误拒绝时，只回退对应策略配置并保留拒绝审计；不得关闭来源校验或审批凭据来恢复功能。密钥异常时先保留原文件和数据库副本，再按显式恢复流程处理。发现插件逃逸、跨会话/租户数据访问或未授权副作用时，停止远程/共享服务并保全本地审计数据。
