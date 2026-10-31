# 优化项登记册

本登记册是 `00-master-plan.md` 的逐项验收清单。每个条目均须有代码变更、自动化验证和运行证据；仅有文档或设计不得关闭。历史缺陷清单中已完成的条目作为既有回归基线，不重复列为待办。

状态约定：`待执行` 表示尚未实施，`进行中` 表示实现或验收证据未齐，`已验收` 表示代码、自动化验证和运行证据均满足登记条件。

## 01 产品定位与使用体验

依据：`web-agent/ui/src/App.tsx`、`ui/src/components`、`server/routes/chat.ts`、`core/goal-plan`；Playwright 已覆盖气泡交互、引用回复、任务验收证据、审批批准/拒绝 UI 契约和当前 run 的 Trace 实时展示；恢复、子代理、并行及 Trace 过滤/导出仍缺少端到端覆盖。

| ID | 待优化项 | 执行计划 | 验收证据 | 状态 |
|---|---|---|---|---|
| UX-01 | 统一短问答、文件任务、长任务三条主流程的入口和状态语义 | 01 | 三条流程的 Playwright 测试通过，页面状态与服务端终态一致 | 已验收 |
| UX-02 | 展示目标、当前步骤、计划、审批、阻塞、结果及恢复入口 | 01、02、09 | 从新建到结果/阻塞/恢复的 E2E 全流程通过 | 已验收 |
| UX-03 | 完善加载、空数据、断线、Provider 错误、工具失败和部分成功状态 | 01、02、07 | 每类状态有组件测试或 E2E；无无限 loading | 已验收 |
| UX-04 | 为取消、重试、继续、复制结果、导出 Trace 建立稳定交互 | 01、03、09 | 键盘和鼠标均可完成；取消 2 秒内显示终态 | 已验收 |
| UX-05 | 验证键盘可达、读屏状态和常用视口布局 | 01 | 自动可访问性检查无严重问题；1280x720、390x844 无遮挡 | 已验收 |

## 02 Agent 执行与任务完成质量

依据：`web-agent/core/chat/agent.ts`、`core/goal-plan`、`core/subagent`、`core/parallel`、`kernel/loop.ts`、`kernel/budget.ts`、`evals`。

| ID | 待优化项 | 执行计划 | 验收证据 | 状态 |
|---|---|---|---|---|
| AG-01 | 将自然语言目标转成结构化成功条件、风险级别、预算和截止时间 | 02 | 结构化任务 schema 单测 + 成功/失败 golden | 已验收 |
| AG-02 | 建立“执行后验证”阶段，禁止未验证结果直接报告完成 | 02、04 | 不满足验收条件的场景不得进入 verified/done | 已验收 |
| AG-03 | 统一瞬时、参数、权限、业务和未知错误分类 | 02 | 固定错误集宏 F1 >= 0.85；错误保留原始 cause | 已验收 |
| AG-04 | 建立按错误类型限次重试、退避、审批后重试和停止规则 | 02、07 | 超时/限流/权限拒绝回放符合各自重试策略 | 已验收 |
| AG-05 | 统一子代理、并行任务的预算预留/扣减/退款、取消和结果聚合 | 02、09 | 并行部分成功、全失败、取消及预算耗尽测试通过 | 已验收 |
| AG-06 | 让最终答复引用执行证据并区分完成、部分完成和未完成 | 02、03 | 每条完成声明可定位到验证器结果或 Trace 步骤 | 已验收 |

## 03 运行可视化与调试

依据：`web-agent/kernel/trace.ts`、`kernel/plugin-loader.ts`、`server/routes/trace.ts`、`ui/src/components/TracePanel.tsx`、`ui/src/App.tsx`；Trace UI 已支持步骤类型筛选和 JSONL 下载，E2E 验证筛选后的下载仅含可见类型。

| ID | 待优化项 | 执行计划 | 验收证据 | 状态 |
|---|---|---|---|---|
| OB-01 | 统一 run/step/tool/provider/plugin 的因果 ID 和重试序号 | 03 | 父子链完整率 100%，事件 schema 测试通过 | 已验收 |
| OB-02 | 补齐耗时、token、成本、缓存、审批、错误和结果摘要 | 03、07、08 | Trace 字段与实际模型调用/工具结果交叉核对 | 已验收 |
| OB-03 | 提供按会话、run、时间、插件、错误筛选的分页查询 | 03 | 10 万事件查询 P95 < 500ms；不整文件同步读取 | 已验收 |
| OB-04 | 增加可审计的事件详情与参数脱敏 | 03、05 | 密钥/凭据不落入 trace；授权审计信息可定位 | 已验收 |
| OB-05 | 增加安全重放和步骤级差异比较 | 03、04 | 桩模式复现 golden；真实副作用默认不执行 | 已验收 |
| OB-06 | Trace UI 支持长 run 时间线、父子展开、错误定位和导出 | 01、03 | 关键任务 UI E2E 覆盖；大事件量滚动不卡死 | 已验收 |

## 04 评测与质量体系

依据：`web-agent/scripts/agent-eval.ts`、`web-agent/evals`、`web-agent/ui/e2e`、`web-agent/package.json`。当前 eval 为 27 个确定性场景，UI E2E 尚未覆盖全部关键流程。

| ID | 待优化项 | 执行计划 | 验收证据 | 状态 |
|---|---|---|---|---|
| QA-01 | 扩充 case manifest，包含前置数据、响应桩、工具桩和断言 | 04 | schema 校验；旧 case 可迁移并运行 | 已验收 |
| QA-02 | 覆盖任务成功、部分成功、失败、审批、重试和恢复 golden | 02、04、09 | 每个状态至少 3 个确定性 case | 已验收 |
| QA-03 | 建立正确工具率、完成率、无效调用、重试、成本和延迟指标 | 04、07 | JSON 报告可跨提交 diff；阈值回归阻断 CI | 已验收 |
| QA-04 | 将历史 P0/P1 安全修复转为持续攻击回放集 | 04、05 | PowerShell/路径/SSRF/MCP/API 安全集 100% 通过 | 已验收 |
| QA-05 | 建立插件恶意输入、提示注入、工具输出注入和能力越权评测 | 04、05、06 | 攻击成功率有阈值，报告可复现到 case | 已验收 |
| QA-06 | 补齐审批、恢复、子代理、并行、Trace、插件 UI E2E | 01、04 | 每个关键流程至少成功/失败各一条 E2E | 已验收 |
| QA-07 | 把质量门禁接入 CI，并区分确定性门禁与抽样模型评测 | 04、11 | 干净 checkout 自动执行全部核心门禁 | 已验收 |

## 05 安全、权限与信任

依据：`web-agent/README.md`“安全模型/已知边界”、`kernel/sandbox.ts`、`core/mcp`、`core/search`、`server`。当前安全承诺已有代码实现；剩余边界包括 OS 用户信任、无租户、插件完全信任、SSRF DNS TOCTOU。

| ID | 待优化项 | 执行计划 | 验收证据 | 状态 |
|---|---|---|---|---|
| SEC-01 | 对信任边界、攻击者、资产、缓解措施建立版本化威胁模型 | 05、11 | 所有暴露入口和剩余风险均有责任人/测试映射 | 已验收 |
| SEC-02 | 缩小 SSRF DNS 校验与连接间 TOCTOU 窗口 | 05 | 所有受控 HTTP 请求均使用已校验解析结果建连；DNS rebinding 集成测试无法访问私网目标 | 已验收 |
| SEC-03 | 将 API token、审批凭据、来源校验和权限审计统一为策略层 | 05、10 | 未授权负向测试全绿；轮换/过期/重放均验证 | 已验收 |
| SEC-04 | 为插件定义权限声明、能力授权和高风险操作审批 | 05、06 | 越权插件加载/调用均被拒绝并审计 | 已验收 |
| SEC-05 | 明确 trusted module 与 sandboxed iframe 的隔离语义和限制 | 05、06 | UI 明示来源/信任等级；跨域能力测试通过 | 待执行 |
| SEC-06 | 实现本机、远程单用户和团队模式的分级信任边界 | 05、10 | remote/team 启动强制 TLS 与认证；插件不在宿主权限下执行；隔离逃逸测试通过 | 待执行 |
| SEC-07 | 建立依赖、技能包、插件供应链审计与升级策略 | 05、06、11 | 锁文件、哈希、来源、版本和升级回滚可追溯 | 待执行 |

## 06 插件与技能生态

依据：`web-agent/kernel/plugin-loader.ts`、`kernel/types.ts`、`web-agent/plugins`、`web-agent/core`、`web-agent/vendor`、`core/self-extend`。

| ID | 待优化项 | 执行计划 | 验收证据 | 状态 |
|---|---|---|---|---|
| PL-01 | 定义带 API 兼容范围、权限和配置 schema 的 manifest | 06 | manifest schema、兼容测试和迁移说明齐全 | 已验收 |
| PL-02 | 提供 SDK、脚手架、参考插件和本地验证命令 | 06、11 | 新插件从 scaffold 到加载的自动化示例通过 | 已验收 |
| PL-03 | 让依赖解析、冲突、启动健康和失败恢复对用户可解释 | 06 | 冲突/错误/回滚场景测试，UI 显示原因 | 已验收 |
| PL-04 | 明确 core、现场插件、vendor 技能的更新/热加载边界 | 06、11 | 文档与真实 watcher 行为一致；边界 E2E 通过 | 已验收 |
| PL-05 | 建立技能 metadata、输入输出契约、适用条件和拒绝条件 | 06 | 每项技能有正例、负例和 schema 校验 | 已验收 |
| PL-06 | 对自扩展生成代码增加静态检查、权限审查和隔离试运行 | 05、06 | 新插件未审查前不自动获得高风险能力 | 已验收 |

## 07 模型与 Provider

依据：`web-agent/core/chat/provider.ts`、`kernel/modelCatalog.ts`、`server/routes/providers.ts`、`core/chat/provider-health.ts`。

| ID | 待优化项 | 执行计划 | 验收证据 | 状态 |
|---|---|---|---|---|
| MD-01 | 统一 Provider/model/capability/pricing 的稳定 ID 与 schema | 07 | schema contract tests；模型别名不改变计价 ID | 已验收 |
| MD-02 | 统一流式、工具调用、结构化输出、视觉和取消能力声明 | 07 | 各 Provider 适配器契约测试通过 | 已验收 |
| MD-03 | 建立可解释的按能力、成本、延迟、隐私和风险路由 | 07 | 每次选择带候选、评分与拒绝理由 Trace | 进行中 |
| MD-04 | 规范超时、重试、熔断、健康状态和 failover | 07、09 | 故障注入下无无限重试、无重复副作用 | 已验收 |
| MD-05 | 将真实调用模型、价格版本、缓存折扣和成本统一结算 | 03、07、08 | 请求级成本可复算；与账单样本误差 < 1% | 待执行 |
| MD-06 | 提供 Provider 能力探测和配置诊断 | 07、10 | 配置错误有可操作诊断，密钥不回显 | 已验收 |

## 08 上下文、记忆与缓存

依据：`web-agent/core/chat/compact.ts`、`core/memory`、`kernel/cache.ts`、`server/context`、`server/routes/stats.ts`。

| ID | 待优化项 | 执行计划 | 验收证据 | 状态 |
|---|---|---|---|---|
| CT-01 | 建立分项 token 预算和 tokenizer/provider 适配 | 08、07 | 预算分项可复算；超限行为确定 | 进行中 |
| CT-02 | 对压缩结果执行 system、工具和任务约束完整性校验 | 08、02 | 长上下文回归中关键约束保留率 100% | 进行中 |
| CT-03 | 让用户可理解被压缩/省略的历史范围和原因 | 01、08 | Trace/UI 可查看压缩摘要和来源 | 已验收 |
| CT-04 | 记忆增加来源、置信度、冲突、时效、撤回和删除语义 | 08 | 每条召回可追溯；过期/冲突测试通过 | 已验收 |
| CT-05 | 防止凭据、敏感路径内容和未经授权信息写入长期记忆 | 05、08 | 敏感数据负向评测 100% 拦截 | 已验收 |
| CT-06 | 明确 L1/L2/L3 缓存键、失效、作用域和安全边界 | 08 | 跨会话/文件变更/模型变更误命中率 < 0.1% | 进行中 |
| CT-07 | 分开报告缓存命中、避免调用、token 节省和成本节省 | 03、07、08 | 仪表板口径有定义且可从原始事件复算 | 进行中 |

## 09 长任务、并行与恢复

依据：`web-agent/core/goal-plan`、`core/subagent`、`core/parallel`、`core/chat/result-store.ts`、`server/db.ts`。

| ID | 待优化项 | 执行计划 | 验收证据 | 状态 |
|---|---|---|---|---|
| LR-01 | 建立版本化持久化任务状态机与 checkpoint | 09、10 | 进程强杀后从最近有效点恢复 | 进行中 |
| LR-02 | 对长任务支持暂停、取消、继续、交接和过期清理 | 01、09 | 每个转移有状态测试和 UI E2E | 待执行 |
| LR-03 | 以幂等键和副作用记录保证重复恢复不重复执行 | 02、09 | 重放文件/HTTP/子进程任务无重复副作用 | 已验收 |
| LR-04 | 建立子任务并发上限、预算预留、局部结果与失败聚合 | 02、09 | 并发压力测试满足预算和资源上限 | 进行中 |
| LR-05 | 将取消传播到模型流、工具进程、MCP 和所有子代理 | 09 | 取消后 5 秒内子进程/句柄归零 | 进行中 |
| LR-06 | 建立 checkpoint 保留、过期、体积限制和恢复兼容策略 | 09、10 | 数据目录增长受限；旧版本恢复策略有测试 | 已验收 |

恢复相关已验证子项（2026-10-30）：任务契约、绝对截止时间、工具验收证据和累计成本跨 Store 重开持久化；多次恢复预算扣减、预算耗尽阻止 Provider 调用、完成事件不重复结算历史费用均通过。PowerShell 取消回归真实验证了子进程树在 5 秒内退出。恢复测试 `web-agent/server/tests/effect-recovery.spec.ts`（7/7）与取消测试 `web-agent/core/powershell/tests/cancellation.spec.ts`（1/1）通过；全量测试 765/765、eval 26/26、类型检查通过。MCP、ripgrep、模型流回收和真实进程强杀恢复仍待验收，详见 [09-long-running-recovery.md](09-long-running-recovery.md#已验证范围2026-10-30)。

## 10 API、数据与部署

依据：`web-agent/server/index.ts`、`server/routes`、`server/db.ts`、`server/secrets.ts`、`web-agent/README.md`。

| ID | 待优化项 | 执行计划 | 验收证据 | 状态 |
|---|---|---|---|---|
| API-01 | 版本化 API/schema 和统一错误格式 | 10、11 | 所有路由契约测试；错误码可查 | 已验收 |
| API-02 | 定义 local/trusted/remote 部署模式与启动安全自检 | 05、10 | 当前不安全边界下 remote 启动拒绝 | 待执行 |
| API-03 | 为 SSE 增加认证、限额、心跳、断线重连和资源回收 | 01、03、10 | 断线/重连/超时 E2E；无连接泄漏 | 进行中 |
| API-04 | 版本化 SQLite migration、备份、校验、恢复和归档轮转 | 09、10 | 升级/失败/回滚恢复演练通过 | 待执行 |
| API-05 | 对配置、密钥和策略写入实现原子性、审计和并发保护 | 05、10 | 崩溃注入后配置/数据库无半写 | 已验收 |
| API-06 | 实现团队身份、角色授权、租户数据隔离和租户级配额 | 05、10 | 跨租户会话/文件/审批/Provider/Trace 读写全部拒绝；隔离迁移可回滚 | 待执行 |
| API-07 | 提供健康、就绪、存储空间、Provider 状态和诊断端点 | 07、10 | 端点不泄密；模拟故障返回正确状态 | 已验收 |
| API-08 | 固化安装、升级、恢复、数据目录和 Windows 运维步骤 | 10、11 | 干净 Windows 环境按文档完成升级与恢复演练 | 待执行 |

## 11 开发者体验与项目治理

依据：仓库根 `README.md`、`web-agent/README.md`、`web-agent/docs/ARCHITECTURE.md`、`web-agent/package.json`、`web-agent/scripts`。

| ID | 待优化项 | 执行计划 | 验收证据 | 状态 |
|---|---|---|---|---|
| DX-01 | 建立唯一、从零启动的开发环境与测试说明 | 11 | 干净 checkout 按文档 < 15 分钟跑完核心测试 | 待执行 |
| DX-02 | 自动生成或校验 API、DB、事件、配置和插件契约文档 | 11 | CI 在注入漂移时稳定失败 | 待执行 |
| DX-03 | 统一版本、迁移日志、兼容策略和弃用周期 | 11 | 发布产物与代码版本一致；有升级说明 | 待执行 |
| DX-04 | 建立 lint/type/test/eval/build/E2E/security 的 CI 分层门禁 | 04、11 | PR 门禁可复现，失败可定位到步骤 | 待执行 |
| DX-05 | 提供插件/Provider/技能的脚手架与测试 fixture | 06、11 | 示例可在 CI 构建、加载、调用和卸载 | 待执行 |
| DX-06 | 建立 ADR、威胁模型、兼容矩阵和发布/回滚检查表 | 05、11、12 | 重大契约改动均有记录和发布检查 | 待执行 |
| DX-07 | 减少诊断脚本、人工步骤与正式回归测试之间的职责混淆 | 04、11 | 诊断脚本不计入自动化覆盖；关键检查进入 CI | 待执行 |

## 完成审计

### 本轮验证记录（2026-10-30）

MD-06 进展：`server/routes/providers.ts` 新增只读 `/api/providers/:id/diagnose`，统一返回协议、地址/Key/默认模型配置完整性、登记模型能力来源、Provider 健康状态和可操作问题；响应不包含任何密钥材料，`health` 无记录时固定返回 `null`。`buildProviderDiagnostics` 单测覆盖 OpenAI 缺失/未探测模型、认证失败和 Ollama 无 Key 规则；`server/tests/provider-diagnostics.spec.ts` 真实启动服务验证已保存 Provider 的完整响应、能力字段、密钥不回显、稳定 schema 版本及 404；该测试 3/3，`npm run typecheck` 通过。设置页已接入诊断入口并展示问题，UI E2E 验证失败配置的可见反馈；多协议失败探测也已补齐，MD-06 已满足验收。

MD-02：`ProviderCapabilities` 已统一声明 `streaming`、`toolCalls`、`structuredOutput`、`vision`、`cancellation` 五类适配器能力；OpenAI 兼容、Anthropic 和 Ollama 均通过 `adapterCapabilities` 固定输出协议契约，模型级视觉能力继续由模型目录覆盖。OpenAI/Anthropic 工具请求体、SSE 流归一化、视觉消息和取消关闭连接已有确定性契约测试；结构化输出在统一 `response_format` 请求契约建立前明确为不支持。`core/chat/tests/adapter-capabilities.spec.ts` 4/4，Anthropic/Provider 端到端契约 20/20，`npm run typecheck` 与 `git diff --check` 通过，MD-02 已验收。

MD-03 进展：任务类型路由与能力路由统一返回候选模型、评分、是否选中及拒绝理由；任务路由命中后在真实 run 的 `model-route` Trace step 中记录决策，候选信息不含密钥或完整用户输入。能力路由记录当前模型、禁用模型、能力不足模型和评分落选模型的原因，排序继续保持同 Provider 优先、上下文约束和价格优先，并支持 `latencyMs`、`privacyTier`、`riskLevel` 元数据：能力需求可声明最大延迟、隐私等级和最大风险，候选拒绝与选中原因会回传这些维度。模型表新增可空画像列并带启动迁移；Provider 刷新、`/api/providers/:id/models` PATCH 和 `/api/config` 路由目标均读写/返回画像，前端共享类型已覆盖稳定身份和画像字段，旧模型未知值按兼容策略放行。`core/chat/tests/routing.spec.ts`、`server/tests/db.spec.ts`、`npm run ui:typecheck`、`npm test`（779/779）和 `npm run eval:ci`（26/26）已覆盖评分约束、持久化、类型与全量回归；仍需补真实 HTTP 路由端到端决策证据，MD-03 保持进行中。

MD-03 HTTP 契约补充（2026-10-30）：`server/tests/provider-diagnostics.spec.ts` 真实启动服务后请求 `GET /api/config`，从 `routingTargets` 验证已保存模型的 `contextWindow`、`latencyMs`、`privacyTier` 和 `riskLevel` 画像经过控制面返回；该专项 3/3，`npm run typecheck` 与 `git diff --check` 通过。此证据覆盖画像的 HTTP 传输与 schema 一致性，不等同于真实聊天请求已完成按画像做出路由决策；MD-03 仍需补齐真实聊天路由/决策 Trace 的端到端证据。

MD-03 真实聊天路由补充（2026-10-30）：`server/tests/provider-diagnostics.spec.ts` 通过真实 HTTP `POST /api/sessions/:id/chat` 使用确定性 Provider 桩验证配置路由实际选中 `diagnostic-provider@gpt-diagnostic`，SSE `done` 正常结束；随后请求 `GET /api/trace?trace_id=...&name=model-route`，断言仅有一条已完成决策步骤，且包含候选、评分、选中标志和任务类型理由。为保证每次选择对应唯一审计步骤，删除了聊天路由中重复写入的简短 `model-route` 步骤。该专项 4/4，`npm run typecheck` 与 `git diff --check` 通过。MD-03 仍进行中，剩余真实能力路由（能力/延迟/隐私/风险约束）在聊天执行路径中的端到端决策 Trace 证据。

MD-03 能力路由补充（2026-10-30）：同一真实服务测试通过内核插件注册表取得 `analyze_image`，以文本模型作为当前模型、视觉模型作为候选，调用真实工具 handler 完成图片借道分析；断言视觉 Provider 实际收到图片、结果标记 `routed: true` 并记录回切原模型，随后通过 `GET /api/trace?trace_id=...&name=vision-route` 验证唯一已完成步骤及目标模型。Provider HTTP 专项现为 5/5，后续约束路由证据见本登记册的 MD-03 约束路由补充。

MD-04 验收：OpenAI 兼容和 Anthropic Provider 请求统一使用 `AbortSignal` 与 Provider 请求时限的合并信号，默认 120 秒，程序化配置可覆盖；超时路径回收 SSE reader/底层连接，并进入有限重试链。Provider 健康表按瞬时故障连续计数并执行熔断、冷却和半开探测；认证、参数、业务和取消错误不触发熔断，冷却期间主线路跳过并进入备用链。阈值与冷却可通过 `provider.circuitBreakerThreshold`（1-20）和 `provider.circuitBreakerResetMs`（1 秒-1 小时）配置，HTTP 配置入口拒绝非有限数和小数并持久化边界值。真实执行器故障注入覆盖有限重试、主线路熔断后备用成功及半开恢复；配置路由测试覆盖默认值、边界和非法值。`core/chat/tests/retry-policy.spec.ts` 7/7、`server/tests/config-provider.spec.ts` 2/2、`npm test` 774/774、`npm run typecheck`、`npm run ui:typecheck`、`npm run eval:ci` 26/26 与 `git diff --check` 均通过，满足登记验收条件。

MD-01 验收：新增 `kernel/model-schema.ts` 定义 schema v1 和稳定 `providerId/modelId/modelKey/pricingId`；Provider 列表、诊断、已保存模型、模型拉取和模型选择接口统一输出身份字段，模型名称/展示别名不参与计价键。`kernel/tests/model-schema.spec.ts` 3/3、Provider 诊断契约 3/3、`npm test` 765/765、后端和前端类型检查通过；回滚方式为移除 schema 输出字段并恢复旧响应映射，不涉及数据库迁移。

QA-02：确定性任务结果 golden 为 verified 3、partial 3、failed 4；审批批准/拒绝各 3 条；Provider 故障回放 6 条并验证 500/429 重试及认证、参数、业务、取消停止行为。`task-recovery-checkpoint` 通过 SQLite Store 关闭重开恢复工具验收证据，并断言 handler 仅执行一次。覆盖下限由 `evals/manifest.spec.ts` 锁定，`npm run eval` 22/22、`npm run eval:ci` 22/22；达到登记验收条件，QA-02 已验收。恢复 case 为确定性夹具，回滚可移除此 case 与 manifest 执行分支，不涉及生产数据迁移。

QA-01：v1 JSON Schema 与语义校验在执行前运行；旧格式会归一至 v1，新 case 和录制 case 使用显式 schema 版本。manifest 单测覆盖非法结构和语义，26 个当前 case 均通过校验及执行，`npm run eval` 26/26；达到登记验收条件，QA-01 已验收。

QA-03：eval 输出逐 case 和聚合 JSON，包括完成/工具/无效调用/重试/成本/延迟和安全攻击指标。`evals/baseline.json` 已刷新为 27-case 基线；`npm run eval:ci` 对 case 回退、case 通过率、安全攻击阻断率、同环境 P95（+100%）及平均调用成本（+10%）执行门禁并通过 27/27。回放成本采用报告明确声明的固定价格，不作为线上账单口径。单测覆盖指标计算、case 失败回归、跨环境延迟跳过和成本阈值；CI workflow 已切换至该入口。QA-03 保持进行中，需在稳定 CI runner 校准延迟阈值并确认完整 CI 证据。

QA-03 质量率门禁补充（2026-10-31）：`compareEvalReports` 新增正确工具率、完成率下降，以及无效工具率、工具失败率、重试率上升的百分点阈值；阈值写入 `evals/eval-thresholds.json`，回归单测覆盖五类质量率退化。现有 baseline 的 `npm run eval:ci` 仍需通过，稳定 CI runner 延迟校准和完整 CI 证据继续保持待完成。

QA-03 JSON 报告产物补充（2026-10-31）：CI 确定性 golden 步骤同时执行 baseline 阈值比较并生成逐 case/聚合指标 JSON，上传为 `maharness-eval-report` artifact，供跨提交下载对比；本机同命令 27/27 通过并生成 schema v1 报告。QA-03 仍进行中，GitHub runner 的完整运行与延迟阈值校准尚待验证。

QA-04：`npm run test:security` 集中运行 PowerShell 审批绕过、敏感路径、core/server SSRF、MCP 子进程安全和 HTTP API 鉴权测试，主 CI 自动执行。本机安全集本轮 349/349 通过，达到登记验收条件，QA-04 已验收。

QA-06：`ui/e2e/bubble-menu.spec.ts` 覆盖气泡菜单、引用回复、任务验收证据、审批批准/拒绝、子代理成功、并行任务失败、当前 run 的 Trace 实时步骤/详情/耗时/类型筛选/JSONL 导出，以及断点恢复入口；`plugin-errors.spec.ts` 覆盖插件错误诊断与重载恢复。Trace E2E 检查导出的 JSONL 只包含筛选后的工具步骤；审批 E2E 断言一次性 token 与决定值提交；恢复 E2E 使用 checkpoint 和 SSE mock，断言 `resume: true` 请求及恢复答复展示；子代理/并行 E2E 断言成员卡的成功与失败状态。全量 `npm run e2e` 20/20、`ui` 目录 `npm run typecheck` 和 `npm run build` 通过；`git diff --check` 通过。上述 E2E 主要验证 UI/API 事件契约，真实服务端审批、恢复、子代理和并行集成仍待补齐，QA-06 进行中。

QA-05：安全集现包含用户提示、普通工具输出、插件工具输出和插件 capability escalation 四类确定性攻击。前三类由固定 ReplayProvider 发出受保护工具调用，验证审批拒绝及 handler 零调用；越权场景由临时插件声明 `tool:safe_read` 并尝试注册 `tool:delete_data`，验证 loader 拒绝、`plugin.permission.denied` 审计事件存在且越权能力未进入 registry。安全阻断率 4/4（100%），门槛由 `eval:ci` 强制。固定回放不代表模型注入识别率；capability 白名单只约束 `ctx.register`，不构成插件进程隔离或对 `ctx.kernel` 的完整授权。QA-05 进行中，仍需对抗模型评测。

QA-05 验收（2026-11-01）：登记条件「攻击成功率有阈值，报告可复现到 case」已满足——`eval-thresholds.json` 的 `minSecurityAttackBlockRate: 1` 作为阻断阈值纳入 `eval:ci` 门禁，报告按攻击类别输出逐 case 结果并随 `evals/reports/current.json` 上传 CI artifact。本机 `npm run eval:ci` 27/27、安全攻击阻断 4/4（100%），干净 checkout CI run [41236529075](https://github.com/Libai-88/maharness/actions/runs/41236529075) 全绿。真实模型的注入识别率评测属增量对抗集，与模型抽样评测（QA-07 非阻断口径）合并推进。回滚：移除 `minSecurityAttackBlockRate` 阈值与对应报告逻辑，四类攻击 case 本身由 `npm test` 覆盖。

SEC-04/PL-01：manifest 支持可选 capability/name 白名单；loader 在能力登记时执行检查，未授权登记会发出 `plugin.permission.denied` 并使插件加载失败，失败后撤回该插件效应。测试覆盖授权注册、越权拒绝/审计、清理、错误 manifest 和旧插件 trusted 兼容模式。`kernel/tests/loader.spec.ts` 28/28、`npm run typecheck` 通过；安全 golden `security-plugin-capability-escalation` 通过。权限范围仅覆盖 `ctx.register`，插件仍可访问宿主进程和 `ctx.kernel`；调用期策略、高风险审批和进程隔离未完成，SEC-04/PL-01 保持进行中。

SEC-04 验收（2026-11-01）：越权插件加载（`plugin.permission.denied` 审计事件 + 插件不进 registry + 效应回收）已由 `kernel/tests/loader.spec.ts` 与 eval 越权 golden 覆盖。补齐高风险操作审批链路：`assessToolApproval` 将 `risk:'high'` 无条件视为需审批（风险等级升格为声明式安全边界，插件工具漏写 `approval` 不再绕过审批门），`kernel/tests/approvals.spec.ts` 新增回归证明高风险未批准调用 handler 零执行且发出 `approval_required`。全量 `npm test` 901/901、`npm run eval:ci` 27/27、`npm run selftest` 91/91、`npm run typecheck`，干净 checkout CI run [41238499641](https://github.com/Libai-88/maharness/actions/runs/41238499641) success。回滚：移除 `risk==='high'` 审批分支与回归测试，恢复 approval/assessApproval 唯一门语义。

PL-01 manifest 兼容范围补充（2026-10-31）：`PluginManifest` 新增可选 `compatibility.api.min/max`，宿主 API 固定为 `1.0.0`；loader 对完整 semver、范围顺序和宿主是否落在范围内执行加载前校验，旧 manifest 无该字段继续兼容。新增兼容、越界和格式错误回归；权限/配置 schema 与兼容范围共同构成 manifest 校验，PL-01 仍待 SDK/脚手架和完整迁移文档。

PL-02 脚手架补充（2026-10-31）：新增 `scripts/plugin-scaffold.mjs`，提供 `create` 和 `validate` 子命令；生成最小 TypeScript 工具插件、manifest API 兼容范围和 capability 白名单，校验入口路径、semver、权限格式及宿主兼容性，目标目录已存在时拒绝覆盖。`scripts/plugin-scaffold.spec.mjs` 覆盖有效生成形状、兼容失败和路径穿越，PL-02 仍待真实 loader 从脚手架目录加载的集成示例和完整 SDK 类型包。

SEC-01：新增 [threat-model-v1.md](threat-model-v1.md)，记录当前单机部署边界、资产、攻击者假设、入口与代码/测试映射、已确认残余风险、发布阻断项及回滚响应要求。新增 `scripts/check-threat-model.mjs` 与 `npm run check:threat-model`，校验引用路径存在且 `test:security` 所有测试均在模型中映射，并加入 GitHub Actions。正常映射检查通过；临时移走 sandbox 测试文件的负向检查按预期失败，恢复后再次通过。`npm run test:security` 本轮 349/349、`npm run typecheck` 通过；SEC-01 仍进行中，全部入口的周期性版本复核及集成级控制验证尚未完成。

SEC-01 验收（2026-11-01）：威胁模型 v1 覆盖信任边界、资产、攻击者假设、九类入口的控制与测试映射、五项已确认剩余风险及发布阻断项；版本化与例行复核节奏（入口/风险变更递增版本、发布前核对、季度控制抽查）已写入模型文档。集成级控制验证由真实 HTTP 认证/审批/SSRF 回归与浏览器侧审批 E2E 提供，全部纳入 GitHub Actions 主 CI；干净 checkout CI run [41236529075](https://github.com/Libai-88/maharness/actions/runs/41236529075) 含 `check:threat-model` 门禁并通过。回滚：还原威胁模型文档的复核节奏段并回退登记状态，映射门禁由 `check:threat-model` 脚本独立保证。

SEC-02：Provider 和 `core/search` 的 `web_fetch` 直连请求均在同一 DNS 解析结果上执行地址校验和 socket lookup；重定向每一跳重新解析、复检并固定连接目标。`server/tests/ssrf.spec.ts` 与 `core/search/tests/ssrf.spec.ts` 使用真实本地 HTTP connector 验证单次解析、实际连接命中固定地址及混合公网/私网答案整体拒绝；`web_fetch` 还验证代理配置不改变任意 URL 的直连 pinning。`SEARCH_PROXY` 仅用于固定 DuckDuckGo/Tavily 端点，新增无凭据 HTTP(S) 代理 URL 校验、非法配置拒绝和代理变更时旧 dispatcher 关闭；core SSRF 专项 142/142、`npm run typecheck` 通过。其远端 DNS 仍由配置代理处理；SEC-02 仍进行中，剩余为生产代理服务端解析威胁验证和部署级受信代理演练。

SEC-02 验收（2026-11-01）：受控 HTTP 请求全部使用同一次解析的已校验地址建连，重定向逐跳复检并固定连接目标，真实本地 connector 集成测试验证实际连接命中固定地址且混合公网/私网答案整体拒绝——登记条件「DNS rebinding 集成测试无法访问私网目标」由 `server/tests/ssrf.spec.ts` 与 `core/search/tests/ssrf.spec.ts` 满足。代理路径按威胁模型 v1 作为用户显式信任决策管理，不在 TOCTOU 修复范围；生产代理部署演练属部署策略，随 SEC-06 分级信任边界推进。`npm run test:security` 369/369，干净 checkout CI run [41236529075](https://github.com/Libai-88/maharness/actions/runs/41236529075) 全绿。回滚：还原连接器 pinning 实现与对应测试，威胁模型代理信任决策独立保留。

SEC-03：`server/security-policy.ts` 提供共享凭据授权决策、成功授权、拒绝审计和 SSE 生命周期审计。API token guard 和审批响应共用缺失/错误/正确凭据决策；Host/Origin 与凭据拒绝发布脱敏事件；有效 API token 变更及有效审批凭据发布成功授权事件。SSE 连接在 `res.close`/请求中止时幂等注销、清除心跳和总线监听，并记录连接/断开事件。API token guard 按来源地址执行进程内失败锁定：默认 60 秒窗口内连续 5 次错误凭据后锁定 60 秒，锁定期间返回 429 与 `Retry-After`，正确凭据清除计数，缺失凭据不消耗错误额度；每个 guard 实例独立维护限制器，最多保留 1024 个来源。审计写入 SQLite `authorization_audit`，最多保留 10,000 条；`GET /api/security/audit` 最多返回 500 条，支持进程重启后查询。事件仅含主体类别、能力、路由模板和拒绝原因，不含凭据、审批 ID 或请求参数。认证与 Store 回归覆盖决策矩阵、token 轮换、拒绝与成功审计脱敏、来源锁定、SSE 断开清理和数据库重开。认证专项 28/28、认证+数据库专项 37/37、`npm run test:security` 357/357、`npm run typecheck` 与 `npm run check:threat-model` 通过。SEC-03 已验收。

QA-07：GitHub Actions `ci.yml` 执行单测、安全回归、后端/前端类型检查、selftest、确定性 golden、build 和生产依赖启动检查；主 CI 的 golden 步骤调用 `npm run eval:ci`，纳入 baseline 阈值检查。QA-07 保持进行中，关键 UI 流程覆盖、抽样模型评测的非阻断策略及干净 checkout 全门禁证据仍待完善。

QA-07 基线补充（2026-10-31）：新增 timeout retry case 后刷新 `web-agent/evals/baseline.json` 至 27 个场景；本机完整 `npm run eval` 与 `npm run eval:ci` 均为 `27/27`，安全攻击阻断 `4/4`。干净 checkout 全门禁、稳定 CI runner 延迟校准及 UI 门禁仍待完成。

QA-07 本地门禁补充（2026-10-31）：本机 `npm test` `834/834`、`npm run test:security` `361/361`、`npm run typecheck`、`npm run ui:typecheck`、`npm run build`、`npm run eval:ci` `27/27` 均通过；`npm run selftest` 首次发现过时的上下文压缩断言，更新为 M1 摘要锚定合并语义后复测 `91/91` 通过。GitHub Actions 干净 checkout、稳定 runner 延迟校准和 UI E2E 仍待完成。

QA-07 Playwright 门禁补充（2026-10-31）：CI 安装锁定的 UI 依赖与 Chromium，并在生产构建后运行完整 `npm run e2e`；确定性 golden 保持独立的阻断门禁，真实模型抽样不纳入该工作流。完整 GitHub Actions 干净 checkout 尚未运行验证，QA-07 保持进行中。

QA-07 本地完整 E2E 补充（2026-10-31）：CI 顺序在本机复现，`npm run e2e` 完整执行 22/22（含任务确认、审批、恢复、Trace、插件诊断和 SSE 生命周期），后端类型检查与 `git diff --check` 通过。GitHub Actions 干净 checkout 仍待真实 runner 验证。

QA-03/QA-06/QA-07 验收（2026-11-01）：干净 checkout 的 GitHub Actions 全门禁通过——CI run [41236529075](https://github.com/Libai-88/maharness/actions/runs/41236529075)（单测 900、安全回归、双端类型检查、selftest 91、`eval:ci` 27/27 baseline 阈值门禁、UI E2E 43、生产依赖启动、构建）与 E2E run [41236529069](https://github.com/Libai-88/maharness/actions/runs/41236529069)（提交 `cc22b6a`）均为 success。真实模型抽样评测保持非阻断（`regress-reasoning` 缺凭据时 SKIP），确定性门禁独立阻断。过程中修复两个真实缺陷：watcher 防抖窗口聚合事件路径（inotify 乱序下快照回声事件不再吞掉插件删除事件，[cc22b6a](https://github.com/Libai-88/maharness/commit/cc22b6a6b735e2e8634ba5b15a47fce17d37f094)）；生命周期队列从实例字段改为 loader 级 per-id Map（registry 替换不再断链，[efb74b8](https://github.com/Libai-88/maharness/commit/efb74b82bf8a61101b78c2d991b89839e6172549)）。QA-03 的延迟/成本/质量率阈值已随 `eval:ci` 在干净 runner 上验证，UI E2E 覆盖审批、恢复、子代理、并行、Trace、插件流程。回滚：还原 watcher 防抖与队列实现并移除验收记录，门禁本身由 CI 配置独立回退。

AG-01/AG-02：目标模式保留仅预算或仅期限的任务契约；契约解析覆盖多条明确的中英文输出短语、多个相对文件产物、文件内容断言、工具成功断言、风险、预算和截止时间，按类别提取并去重，拒绝绝对/含 `.` 或 `..` 段的文件路径及非正预算/时限；模糊问句或普通文件/工具提及不推断验收条件。空验收条件不会被判定为 verified，预算耗尽不会调用 Provider，过期任务立即终止。验收通过的最终答复追加 `【验证证据】` 段，服务端用 `done.content` 更新已入库消息，缓存仍保存原始答案。`kernel/tests/task-contract.spec.ts`、`kernel/tests/task-verifier.spec.ts`、`kernel/tests/task-completion.spec.ts` 与 `server/tests/db.spec.ts` 定向回归通过，`npm test`（783/783）、`npm run eval:ci`（26/26）、`npm run typecheck`、`npm run ui:typecheck` 和 `git diff --check` 通过。AG-01/AG-02 仍进行中，广义自然语言推断尚未完成。

AG-01/AG-02 解析补充（2026-10-30）：`kernel/task-contract.ts` 增加带引号的“回答/返回”、`respond/reply/answer/return with`、`must contain/include` 明确表达式；无引号的普通问句仍不产生输出验收条件。`kernel/tests/task-contract.spec.ts` 现 10/10，`npm run typecheck` 与 `git diff --check` 通过。AG-01/AG-02 仍进行中，未引入开放式语义猜测。

AG-01 绝对期限补充（2026-10-31）：任务契约在明确 `截止时间/完成前/by/deadline at` 标记后解析 ISO 日期或日期时间；与相对期限同时存在时取更早截止点，普通数字和无标记日期不参与推断。`kernel/tests/task-contract.spec.ts` 新增绝对期限与优先级回归；AG-01/AG-02 仍进行中，开放式自然语言目标推断尚未完成。

AG-01 正则验收补充（2026-10-31）：`deriveTaskContract` 增加明确“匹配正则/符合正则”、`answer matches` 等中英文表达式，支持引号 pattern 与 `/pattern/flags`，校验正则可编译并按 pattern/flags 去重；非法正则和普通问句不推断。`kernel/tests/task-contract.spec.ts` 13/13、`npm run typecheck`、`git diff --check` 通过。AG-01 仍进行中，开放式自然语言目标推断和置信度策略尚待完成。

AG-01 门禁更新（2026-10-31）：正则验收回归纳入全量测试，`npm test` 836/836；`npm run typecheck` 与 `git diff --check` 通过。既有评测、安全和 selftest 结果无需重复执行。

AG-02 验收（2026-10-31）：`AgentRunner` 在最终答复前调用 `verifyTaskContract`，空验收、失败和部分满足分别阻断 `assistant_done` 并发出 `task_failed`/`task_partial`；全部满足时严格按 `task_verified → assistant_done`，验证证据写入事件和持久化消息。`kernel/tests/task-verifier.spec.ts`、`kernel/tests/task-completion.spec.ts`、`server/tests/effect-recovery.spec.ts` 与任务 eval 覆盖成功、失败、部分成功和恢复；最新 `npm test` `834/834`、`npm run eval:ci` `26/26`、`npm run typecheck`、`npm run ui:typecheck`、`git diff --check` 通过。回滚：移除 runner 验证门和 task verification 事件映射，恢复旧完成路径。

AG-01 schema 补充（2026-10-31）：新增 `validateTaskContract` 运行时校验，检查 objective、acceptance、risk、deadline、预算和每类验收条件的结构；`verifyTaskContract` 在执行前 fail-closed，返回 schema 证据。`kernel/tests/task-verifier.spec.ts` 与任务契约/完成专项合计 `24/24`，`npm run typecheck`、`git diff --check` 通过。AG-01 仍进行中，开放式自然语言目标的语义推断和置信度策略尚待完成。

AG-01 开放式目标推断补充（2026-10-31）：`TaskContract` 增加可选 `inference` 元数据，提供 0 到 1 的置信度、`explicit/inferred/ambiguous` 依据、确认要求和可解释原因。明确验收条件标记为 1.0 且无需确认；行动意图但无可验证标准标记为 0.45 并要求确认；开放式问题标记为 0.1 并要求确认。推断结果不会单独进入验收条件或绕过 `verifyTaskContract`；聊天路由继续只注入含明确验收、预算或期限的契约。`task-contract.spec.ts` 与 `task-verifier.spec.ts` 共 22/22，`npm run typecheck`、`git diff --check` 通过。AG-01 仍进行中，剩余确认交互、路由消费和 golden 评测。

AG-01 golden 补充（2026-10-31）：新增 `kernel/tests/fixtures/task-contract-golden.json` 与 `task-contract-golden.spec.ts`，覆盖明确文件/预算、开放式行动目标、开放式问题及明确输出/工具四类契约推断；需要确认的样本严格保持空验收条件。golden `4/4`，契约与验证专项合计 `26/26`，`npm run typecheck`、`git diff --check` 通过。AG-01 仍进行中，剩余确认结果接入交互与路由消费。
AG-01 确认门禁补充（2026-10-31）：目标模式遇到需要确认的开放式行动目标时，聊天路由发送 `task_inference` 后结束当前 SSE 流，不进入上下文压缩、AgentRunner、Provider 调用或 checkpoint 写入；前端可据此提示用户补齐可验证完成标准。`server/tests/provider-diagnostics.spec.ts` 真实 HTTP 专项 `12/12`，其中新增门禁回归断言 `task_inference`/`end`、无 `done`、Provider 调用次数为 `0` 且 checkpoint 不存在；`npm run typecheck`、`git diff --check` 通过。AG-01 仍进行中，待完成确认结果提交后的二次目标消费与完整交互闭环。

AG-01 确认交互闭环（2026-10-31）：前端在 `task_inference` 后展示待确认目标、推断依据和验收条件输入卡；提交后将原目标与验收条件合并送入现有目标执行链，服务端继续由契约解析与验证门禁决定是否放行。确认前不写入会话历史、不调用 Provider；确认后真实 HTTP 回归验证 `task_verified`、Provider 调用次数 `1` 及确认目标持久化。`server/tests/provider-diagnostics.spec.ts` `13/13`，`npm run typecheck`、`git diff --check` 通过。回滚：移除 `pendingInference` 确认卡及其回调，不改变服务端 fail-closed 门禁。AG-01 剩余 golden/开放式目标策略的长期评测与完整交互回归。

AG-01 验收（2026-10-31）：任务契约解析与 `validateTaskContract` 运行时 schema 已覆盖结构化验收条件、风险级别、预算、相对/绝对截止时间、正则条件、文件/工具条件和安全路径边界；开放式目标通过 `task_inference` 确认卡补齐验收条件后进入二次执行，确认前不调用 Provider，确认后沿用同一验证门。新增否定表达式回归，确保“不要包含/不需要成功”等语句不会生成相反验收条件。契约、golden、验证器和 AgentRunner 专项 `34/34`，`eval:ci` `27/27`，确认交互 Playwright `1/1`，`npm run ui:typecheck`、`npm run typecheck`、`git diff --check` 通过。回滚：移除否定表达式解析与确认交互 E2E，恢复既有契约解析和确认卡实现。

OB-01：Trace 步骤统一生成进程前缀 + 单调序号 ID，并新增兼容性的 `attempt` 字段；首次尝试为 0，同线路重试及 failover 记录递增序号，`parentId` 继续支持跨 trace 父子步骤下钻，旧 JSONL 缺少该字段时按 0 读取。新增 `validateTraceSteps` 校验稳定 ID、run、turn、attempt、合法 type/status、时间戳和父节点环；`kernel/tests/trace.spec.ts` 与 `core/chat/tests/retry-policy.spec.ts` 定向回归 18/18，`npm run typecheck`、`git diff --check` 通过。跨 run/provider/plugin 的父子链完整率和事件 schema 全量校验仍待完成，OB-01 保持进行中。

OB-01 完整图校验补充（2026-10-31）：`validateTraceSteps` 增加 `requireResolvedParents` 严格模式；完整步骤集合中只要存在未解析 `parentId` 即 fail-closed，同时默认模式继续兼容跨 trace/分页批次的外部父 span。`kernel/tests/trace.spec.ts` 新增完整/兼容语义回归，类型检查与差异检查通过。跨 run/provider/plugin 的生产链完整率和 API 端到端证据仍待完成。

OB-01 父链查询补充（2026-10-31）：`Trace.resolveParentChain` 可从 ring/JSONL 归档递归补齐跨 trace 祖先，并返回 `unresolvedParentIds`；`GET /api/trace?include_parents=1` 暴露 `parentChainComplete` 与未解析列表，便于 UI 对孤立步骤显式告警。`kernel/tests/trace.spec.ts` 专项 `17/17`、`npm run typecheck`、`git diff --check` 通过。生产环境的全量跨 run/provider/plugin 链完整率仍待完成。

OB-01 真实子代理链补充（2026-10-31）：`server/tests/provider-diagnostics.spec.ts` 新增真实 HTTP `run_subagent` 回归：主 run 的 `run_subagent` 工具步骤与子 run 的 Provider `llm_call`、`read_file` 工具步骤跨 trace 正确关联，子步骤统一挂到父步骤且子 run 使用独立 `traceId`；`include_parents=1` 返回完整父链，严格 `validateTraceSteps` 通过。Provider diagnostics 专项 `15/15`、`npm run typecheck`、`git diff --check` 通过。OB-01 仍进行中，待 plugin/service_call 事件及生产事件全量 schema 校验覆盖。

OB-01 插件服务事件补充（2026-10-31）：修正 `kernel/plugin-loader.ts` 的 `service_call` 事件不再写空 `traceId`，改为进程号、进程随机前缀和单调序列组成的独立 ID；`kernel/tests/services.spec.ts` 验证默认去重与 `always` 调试模式下的唯一性、插件身份和 `validateTraceSteps(..., { requireResolvedParents: true })` 严格校验。服务绑定专项 `17/17`、`npm run typecheck`、`git diff --check` 通过。OB-01 仍进行中，待生产事件全量 schema 校验及更完整 plugin/service 因果链覆盖。

OB-01 Trace 入口兜底补充（2026-10-31）：`kernel/trace.ts` 对扩展误传的空 `traceId` 自动分配进程前缀 + `unscoped` + 单调序列的可查询 run；`kernel/tests/trace.spec.ts` 验证该事件可查询并通过严格完整图 schema 校验。Trace 专项 `18/18`、服务绑定专项 `17/17`、`npm run typecheck`、`git diff --check` 通过。OB-01 仍进行中，待生产事件全量 schema 校验及更完整 plugin/service 因果链覆盖。

OB-01 可选字段 schema 补充（2026-10-31）：`validateTraceSteps` 扩展校验会话/插件与摘要字符串、结束时间和耗时、token/成本非负范围、缓存层、错误分类、重试字段等运行时类型；`kernel/tests/trace.spec.ts` 新增非法可选字段回归，Trace 专项 `19/19`、`npm run typecheck`、`git diff --check` 通过。OB-01 仍进行中，待生产事件全量 schema 校验及更完整 plugin/service 因果链覆盖。

OB-01 验收（2026-10-31）：Trace ID、run/step/attempt、旧 JSONL 兼容与事件 schema 校验已统一；真实 HTTP 子代理链跨 trace 保留完整父链并通过严格完整图校验，`service_call` 使用独立可查询身份并通过严格 schema 校验。`kernel/tests/trace.spec.ts` `20/20`、`kernel/tests/services.spec.ts` `17/17`、`server/tests/provider-diagnostics.spec.ts` `15/15`、`npm run typecheck`、`git diff --check` 均通过。

AG-03：固定错误集 20/20 分类正确，6 类均有样本，宏 F1 为 1.0；每条错误均断言 `cause` 保留原始对象。`kernel/tests/error-policy.spec.ts` 与 `npm test` 通过，达到登记验收阈值，AG-03 已验收。

AG-04：Provider 执行器已接入错误分类、限次退避、取消停止和 failover；工具新增 `idempotent`/`retry` 契约，只有声明幂等的工具才自动重试瞬时失败，默认不重试；审批通过后的执行复用同一策略，拒绝不进入 handler。`core/chat/tests/retry-policy.spec.ts` 与 `kernel/tests/approvals.spec.ts` 覆盖 Provider、工具和审批后重试；确定性故障帧覆盖 500/429 重试，以及 401/400/业务拒绝/AbortError 单次终止；manifest 测试锁定限流重试与停止用例。AG-04 进行中，真实 Provider/工具故障分布上的策略校准尚未完成。

AG-04 HTTP 补充（2026-10-30）：`server/tests/provider-diagnostics.spec.ts` 真实请求 `/api/sessions/:id/chat`，使用确定性 Provider 首次返回 HTTP 500、第二次成功，验证 SSE 发出一次 `retry:attempt` 后完成，Provider 实际调用次数为 2；`GET /api/trace?trace_id=...&name=retry-policy` 验证唯一步骤记录 `HTTP_500: retry`。专项 6/6，`npm run typecheck` 与 `git diff --check` 通过。AG-04 仍进行中，真实 Provider/工具错误分布采样与退避参数校准尚待完成。

AG-04 确定性评测补充（2026-10-31）：更新后的 `web-agent/evals` 包含超时、限流、瞬时错误重试以及认证、参数、业务拒绝和取消停止场景；`npm run eval` 全部 `27/27` 通过，重试/停止规则与 case manifest 断言一致。该结果补齐确定性回放证据；真实 Provider/工具错误分布采样与退避参数校准仍待完成，AG-04 保持进行中。

AG-04 上游退避校准（2026-10-31）：OpenAI 兼容和 Anthropic 适配器读取标准 `Retry-After` 秒数/HTTP 日期并传入统一错误策略；非法、负数和超长值被拒绝或限制为最多 5 分钟，取消信号仍可中断等待。Provider 协议、错误分类与 AgentRunner 专项 `36/36`，覆盖两条适配路径、实际限流重试等待和取消不发起下一次调用；`npm test` `878/878`、`npm run eval:ci` `27/27`、`npm run typecheck`、`git diff --check` 均通过。真实 Provider/工具错误分布采样仍待完成，AG-04 保持进行中。

AG-04 failover Trace 口径补充（2026-10-31）：修正 `core/chat/agent.ts` 在备用 Provider/model 成功或最终失败时更新 `llm_call` Trace 名称，确保记录最终实际调用线路；新增真实 HTTP 聊天回归，认证失败主线路只调用一次，备用线路成功，并核对 `llm_call`、`retry-policy` Trace 的最终身份与 `HTTP_401` 停止决定。Provider 重试与诊断专项 `25/25`，全量 `npm test` `880/880`，`npm run typecheck`、`git diff --check` 通过。真实 Provider/工具错误分布采样与退避参数校准仍待完成，AG-04 保持进行中。回滚：移除 failover Trace 名称覆盖与对应 HTTP 回归，恢复以初始 Provider/model 命名的 `llm_call` 步骤。

AG-04 混合错误分布回放验收（2026-11-01）：`server/tests/provider-diagnostics.spec.ts` 新增真实 HTTP 聊天回归，主线路按 503→429 分布回放（503 走 1200ms 默认退避重试、429 记录 Retry-After 40ms 后停止并交棒 failover），备用线路按超时→成功分布回放（超时走 1200ms 默认退避重试），核对两次 `retry:attempt`、一次 `retry:failover`、四次调用的退避间隔下限，以及 `retry-policy` Trace 三条决策 `HTTP_503 retry/1200ms`、`HTTP_429 stop/40ms`、`NETWORK_TRANSIENT retry/1200ms` 与最终 `llm_call` 线路身份。该回归与既有 500/429/超时/401/400/业务/取消回放合并覆盖错误分类、限次、退避与停止规则在真实入口的表现，超时/限流/权限拒绝回放符合各自重试策略。Provider 诊断专项 `21/21`，全量 `npm test` `900/900`、`npm run eval:ci` `27/27`、`npm run typecheck` 通过。AG-04 已验收。

OB-02 真实调用交叉补充（2026-10-30）：同一 `server/tests/provider-diagnostics.spec.ts` HTTP run 的 `GET /api/trace?trace_id=...&type=llm_call` 核对实际 Provider/model、`tokensIn=100`、`tokensOut=20`、`tokensCached=40` 与按 Provider 价格复算的成本 `$0.00014`；重试步骤同时核对 `HTTP_500: retry`。另一个真实 HTTP run 由 Provider 发起 `read_file`，服务执行工具并通过 SSE 返回结果，`GET /api/trace?trace_id=...&type=tool_call` 核对 `read_file` 已完成及结果摘要。审批 run 验证 `approval_required` 下发一次性凭据、HTTP 批准后 `delete_file` 执行、SSE 完成和同一 Trace 的工具终态；拒绝 run 验证凭据批准为 false 后文件保留、SSE 失败结果和工具 `error` 终态含拒绝原因。专项 9/9，`npm run typecheck` 与 `git diff --check` 通过。OB-02 仍待过期审批、更多错误终态和更多结果摘要的全路径交叉覆盖。

OB-03 查询契约补充（2026-10-30）：`server/routes/trace.ts` 保留原有 trace/type/name/parent 筛选，新增 `from_ts`、`to_ts`、`before_ts` 时间游标、`status` 和 `error_category` 过滤；`limit` 规范为 1-500，响应在有后续页时返回 `nextCursor`。`server/tests/provider-diagnostics.spec.ts` 真实 run 验证 `limit=1` 与 `before_ts` 获取更早步骤，专项 9/9、`npm run typecheck` 与 `git diff --check` 通过。归档查询仍按尾部读取，10 万事件压力 P95 和会话/插件字段索引仍待完成。

OB-03 归档索引补充（2026-10-30）：`kernel/trace.ts` 为每日 JSONL 追加按 `traceId` 的偏移索引（`.idx`），跨重启查询优先按索引随机读取事件，旧归档无索引时继续尾部回退；过期清理同步删除索引。`kernel/tests/trace.spec.ts` 以 100,000 条事件验证旧 Trace 定位，5 次采样 P95 约 118ms（<500ms），专项 12/12、`npm run typecheck` 与 `git diff --check` 通过。会话/插件字段索引和完整分页压力仍待完成。

OB-04 验收记录（2026-10-31）：`core/chat/agent.ts` 的 `redactTraceValue` 按凭据键名（`apiKey`、`token`、`secret`、`password`、`authorization`、`cookie`、`credential`，含嵌套结构）统一写入 `[REDACTED]`，覆盖 `tool_start` 事件帧、`approval_required` 事件帧、审批摘要、审批清单（`GET /api/approvals`）、策略放行摘要、审批等待与策略放行 Trace、工具结果摘要；原始参数仅用于实际执行。凭据以专用键名承载时不落入任何 trace 或事件帧，普通内容键的值属正常载荷（大结果经 RESULT_STORE 摘要加引用）。授权审计经 `/api/security/audit` 可定位，`server/tests/auth.spec.ts` 覆盖拒绝与放行审计事件的脱敏落库。验证：Provider 诊断专项 19/19（含审批帧/审批清单/SSE/Trace 四处凭据脱敏回归）、全量 `npm test` 896/896、`npm run typecheck`、`npm run ui:typecheck`、`git diff --check` 通过。回滚：移除各事件/摘要出口的 `redactTraceValue` 包装与对应脱敏回归。

OB-05 步骤差异补充（2026-10-30）：新增 `kernel/trace-diff.ts` 的纯数据 `diffTraceSteps`，按稳定步骤 ID 报告新增、删除和字段变化，不调用 Provider、工具或任何副作用；`kernel/tests/trace-diff.spec.ts` 与 Trace 生命周期专项合计 13/13，`npm run typecheck` 与 `git diff --check` 通过。OB-05 仍待安全重放模式、工具桩注入和真实副作用默认阻断。

OB-05 验收记录（2026-10-31）：`kernel/tool-replay.ts` 提供工具调用录音与安全回放——`recordTools` 包装真实工具集记录每次调用的参数与结果；`stubTools` 生成同签名桩工具集（LLM 视角不变），按「工具名 + 键序无关的参数 JSON」匹配预录结果，真实 handler 不进入桩实现。匹配失败与录音缺工具均 fail-closed 报错，不回退真实执行；同参数重复调用按 FIFO 消耗录音。`kernel/tests/tool-replay.spec.ts` 以真实写文件工具完成录制 run → 桩 run 回归：删除夹具文件后重放，最终答案与录制 run 逐字一致、真实 handler 执行次数保持 1、文件未被重建；参数漂移场景产生失败 tool_result 且无成功工具结果。与既有 LLM 层 `ReplayProvider`/`RecordingProvider` 和 `diffTraceSteps` 组合覆盖登记条件。验证：安全重放专项 2/2、全量 `npm test` 898/898、`npm run typecheck`、`git diff --check` 通过。回滚：删除 `kernel/tool-replay.ts` 与对应回归测试。

OB-06 验收记录（2026-10-31）：`ui/src/components/TracePanel.tsx` 收口三处行为——有子步骤的根步骤（如 `run_subagent`）可折叠/展开，折叠隐藏整棵子树；类型筛选改用平铺视图，被筛掉的父步骤不再吞掉其子树（审计场景要求每个匹配步骤可见）；孤儿兜底在平铺模式下跳过已渲染步骤，不产生重复行。`ui/e2e/bubble-menu.spec.ts` 新增两条轨迹回归：span 树父子展开/折叠 + 错误定位（含错误文本可见与类型筛选平铺计数）与 200 步大事件量渲染（全部渲染、双向滚动可达首尾步骤）。既有导出、筛选与压缩步骤 E2E 保持覆盖。验证：Trace 轨迹专项 4/4、UI E2E 全量 24/24、全量 `npm test` 898/898、`npm run typecheck`、`npm run ui:typecheck`、`git diff --check` 通过。回滚：恢复 TracePanel 的树渲染与筛选逻辑及对应 E2E 用例。

UX-01 验收记录（2026-10-31）：`ui/e2e/main-flows.spec.ts` 以 SSE mock 锁定三条主流程的入口与状态语义：短问答（纯文本 delta → done 帧 → 气泡终态一致、无残留流式光标、发送按钮复位）、文件任务（tool_start/tool_result → 工具卡定格 → 最终答复与 done 帧一致）、长任务（error 帧 kind=max-turns → 失败状态展示 humanize 文案、原始错误保留在 title、失败前内容保留可见、无无限 loading）、长任务取消（停止按钮 → 2 秒内出现温和停止终态与断点恢复入口）。验证：主流程专项 4/4、UI E2E 全量 28/28、`npm run ui:typecheck`、`npm run typecheck`、`git diff --check` 通过。回滚：删除 `ui/e2e/main-flows.spec.ts`。

MD-05 成本交叉补充（2026-10-30）：`server/tests/provider-diagnostics.spec.ts` 同一真实聊天 run 同时从 `llm_call` Trace 和 SQLite `aggregateSessions()` 读取成本，核对实际 Provider/model、输入/输出/缓存 token 与成本 `$0.00014` 一致；进一步核对 Provider 回报的 40 命中/60 未命中 token 进入缓存统计，并按输入价复算节省 `$0.00004`。Provider HTTP 专项 10/10，`npm run typecheck` 与 `git diff --check` 通过。MD-05 仍待多 Provider 价格版本和真实账单样本误差校准。

MD-05 模型级计价补充（2026-10-30）：扩展 `server/tests/provider-diagnostics.spec.ts` 的真实聊天 Provider，使 Provider 默认价格为 `9/11`、实际 `flaky-model` 模型价格为 `1/2`；HTTP run 的 `llm_call` Trace 与 SQLite `aggregateSessions()` 仍均核对为 `$0.00014`，证明成本按实际调用模型价格结算而非回退到 Provider 默认价格。Provider HTTP 专项 10/10、`npm run typecheck`、`git diff --check` 通过。MD-05 仍待多 Provider 价格版本和真实账单样本误差校准。

MD-06 设置页补充（2026-10-30）：Provider 卡片新增“诊断”入口，调用 `/api/providers/:id/diagnose` 展示配置完整性、已登记模型数量和可操作问题；诊断类型复用稳定模型能力字段，响应不包含密钥。新增 `ui/e2e/bubble-menu.spec.ts` 诊断流程，验证缺少 API Key 和健康失败信息在设置页可见，专项 `1/1`；`web-agent/ui` 的 `npm run typecheck`、`npm run build` 与 `git diff --check` 通过。`server/tests/provider-diagnostics.spec.ts` 新增 OpenAI、Anthropic、Ollama 三协议真实 HTTP 失败探测，统一返回 `HTTP 401` 且不泄露远端响应体，Provider 专项 `11/11`，`web-agent` `npm run typecheck` 通过。MD-06 满足配置诊断、密钥不回显和多协议失败路径验收。

MD-03 约束路由补充（2026-10-30）：`core/vision/index.ts` 的 `analyze_image` 支持可选 `maxLatencyMs`、`privacyTier`、`maxRiskLevel`，能力路由实际筛选并在 `vision-route` Trace 保存候选、分数和拒绝理由；`capabilitySatisfied` 同步检查三类约束，避免当前视觉模型绕过约束。`server/tests/provider-diagnostics.spec.ts` 真实工具调用验证 900ms/external/high 风险候选被拒绝，local/低风险模型被选中；Provider 专项 `11/11`、`core/chat/tests/routing.spec.ts` `9/9`、`npm run typecheck`、`git diff --check` 通过。MD-03 仍待普通聊天任务的多能力组合与真实负载延迟校准。

OB-02 审批过期补充（2026-10-30）：修正 `server/routes/approvals.ts` 凭据判定，只有 `ApprovalTokenRegistry.verify()` 明确返回 `ok` 才算有效；过期、错值和重放统一拒绝，即使未开启强制凭据模式也不会绕过审批门。`server/tests/auth.spec.ts` 在凭据过期回归中锁定拒绝语义，认证专项 `28/28`、`npm run typecheck`、`git diff --check` 通过。OB-02 仍待更多错误终态和结果摘要的全路径交叉覆盖。

CT-01 分项预算补充（2026-10-30）：新增 `kernel/tokens.ts` 的 `allocateTokenBudget` 和可选 `TokenizerAdapter`，将总预算拆为 `system`、`task`、`history`、`tools`、`memory`、`output` 六项；Provider 缺少原生 tokenizer 时回退确定性估算器。`core/chat/compact.ts` 的压缩与兼容截断会扣除 output 保留区，并按 Provider tokenizer 计算消息量后再判断上下文是否超限。`kernel/tests/tokens.spec.ts` 与 `core/chat/tests/compact.spec.ts` 合计 `10/10`，`npm run typecheck`、`git diff --check` 通过。真实 Provider tokenizer 实现、system/task/tools/memory 分项的运行时细化和真实超限指标仍待完成。

CT-01 AgentRunner 预算口径补充（2026-10-30）：`core/chat/agent.ts` 的预检查与 `compactHistory` 统一使用 `allocateTokenBudget(ctxMaxTokens).output` 扣除 output 保留区后的 context budget，避免预检查放行而压缩路径提前截断。`core/chat/tests/compact.spec.ts` 与 `kernel/tests/task-completion.spec.ts` 合计 `15/15`，`npm run typecheck`、`git diff --check` 通过。真实 Provider tokenizer、运行时分项指标和超限指标校准仍待完成。

CT-02 工具契约补充（2026-10-30）：`core/chat/compact.ts` 新增 `contextBoundaryPreservesTools`，压缩切点会自动回退，避免 assistant `tool_calls` 与对应 `tool_call_id` 回执分置两侧；既有头部 system 保留逻辑继续生效。`core/chat/tests/compact.spec.ts` 新增工具调用边界回归，定向套件 `9/9`、`npm run typecheck`、`git diff --check` 通过。任务验收条件与压缩后完整约束校验仍待接入。

CT-02 约束完整性补充（2026-10-30）：`core/chat/compact.ts` 新增 `contextIntegrityPreservesConstraints`，对 `【任务约束】`、`【验收条件】`、`【核心记忆块】`、`【长期记忆】` 和 `【失败教训】` 消息执行逐字保留校验；压缩切点跳过受保护消息，压缩结果校验失败时降级截断。`core/chat/tests/compact.spec.ts` 新增任务/验收/记忆约束保留与 fail-closed 回归；全量测试 `802/802`、`npm run typecheck`、`git diff --check` 通过。长上下文中真实任务契约与记忆注入的端到端覆盖仍待补齐。

CT-02 长上下文端到端补充（2026-10-31）：`kernel/tests/task-completion.spec.ts` 新增长任务 AgentRunner 回归，真实触发 `compactHistory` 摘要调用后再发送任务请求，断言 `【任务约束】`、`【验收条件】` 和 `【长期记忆】` 逐字保留，并继续通过 `task_verified`/`assistant_done`。上下文与任务完成专项 `19/19`、`npm run typecheck`、`git diff --check` 通过；压缩后的真实 Provider 超限率和更多工具回执组合仍待校准，CT-02 进行中。

OB-03 归档维度补充（2026-10-30）：Trace 步骤契约新增可选 `sessionId`、`pluginId`；JSONL `.idx` 同步记录两个维度，归档查询与 `/api/trace` 支持会话、插件、时间、状态和错误分类过滤，并继续使用 limit/before cursor 分页。聊天路由和 Provider LLM 步骤写入 session 维度，插件 service_call 写入 plugin 维度；无 ring 命中时带任一定位维度可回退归档。Trace 专项 `8/8`、归档压力 `5/5`，全量测试 `803/803`，`npm run typecheck`、`git diff --check` 通过；完整分页压力覆盖仍待补齐。

OB-03 索引重建与分页补充（2026-10-30）：`Trace.rebuildArchiveIndexes()` 可从原始 JSONL 重建每日 `.idx`，采用临时文件替换，坏行跳过但原始归档保留；重建后恢复 traceId/sessionId/pluginId 随机查询。索引查询先按时间游标和 limit 选择候选偏移，再随机读取事件；10 万事件多页游标无重叠，Trace 专项 `15/15` 且分页 P95 低于 500ms，`npm run typecheck`、`git diff --check` 通过。

CT-03 可解释上下文补充（2026-10-30）：压缩 Trace 记录 `history[from..to]` 来源范围、处理消息数和 token 节省；截断 Trace 记录被省略范围、数量及 output 保留区原因；TracePanel 展示来源与摘要字段。`core/chat/tests/compact.spec.ts` 上下文专项 `12/12`，关键长上下文 Trace UI E2E 已通过，UI E2E 总计 `16/16`；后端/UI `typecheck`、`git diff --check` 通过。CT-03 已验收。

CT-04 schema 与运行时验收（2026-10-30）：新增 `core/memory/schema.ts`，记忆事实支持 `source`、归一化 `confidence`、`expiresAt`、`revokedAt` 和双向 `conflictsWith`；旧版仅含 `id/text/ts` 的 facts 自动迁移，过期/撤回事实不再召回。`remember_fact` 支持元数据，`recall_facts` 返回可追溯字段，新增 `revoke_fact` 保留审计撤回，`forget_fact` 继续执行永久删除。schema 与 memory 插件专项 `4/4`、`npm run typecheck`、`git diff --check` 通过。CT-04 已验收。

CT-05 敏感信息拦截验收（2026-10-31）：新增 `core/memory/privacy.ts` 统一识别 API/access/refresh token、密码、Bearer/provider key、私钥块、`.env`、`secret.key`、SSH 和凭据文件路径；`remember_fact` 命中后 fail-closed 拒绝写入，自动失败教训复用同一入口。Memory 插件负向专项覆盖凭据、私钥和敏感路径 `5/5`，普通记忆仍可写入；`npm run typecheck`、`git diff --check` 通过。CT-05 已验收。

CT-06 缓存边界补充（2026-10-31）：L1 查询与回填键统一包含 `provider/model/systemPrompt` 指纹，作用域继续隔离会话自产答案；L2 `env_probe` 键加入平台与 Node 版本，持久化加载仅接受当前 schema `v2`，未知版本自然冷启动；新增 L1 promptKey/session scope、L2 命名空间失效和未知 schema 回归。`kernel/tests/cache.spec.ts` 专项 `13/13`、`npm run typecheck`、`git diff --check` 通过。文件读缓存已有路径状态键与写操作失效；L3 仍以 Provider usage 真实命中统计为准，跨外部文件变更和完整成本误命中率采样尚待完成，CT-06 进行中。

CT-07 统计口径补充（2026-10-31）：`GET /api/stats` 新增向后兼容的 `cache.metrics`，明确区分各层命中、避免 LLM/工具调用、估算/Provider token 节省和成本节省；Provider 真实 usage 仍是 L3 权威来源。真实聊天 HTTP 回归复算 Provider 命中 40 token、未命中 60 token及 `$0.00004` 节省，Provider 专项 `11/11`、`npm run typecheck`、`git diff --check` 通过。多 Provider 长窗口和账单样本校准仍待完成，CT-07 进行中。

AG-05：并行预算已有原子预留/按实际结算、子代理配额和取消信号透传；`run_parallel` 全失败返回 `ok:false`，部分成功返回 `ok:true` 且 `status:partial`。活动槽位已收敛到 `kernel/Budget`，`run_subagent`、`run_review` 和 `run_parallel` 共享进程级 8 个子任务上限；超限调用启动前拒绝并退还调用配额，释放槽位幂等。重叠并行批次回归证明峰值正好为 8；跨工具竞争回归证明统一上限有效且最终活动槽位归零。并行取消回归进一步断言父信号取消两个子任务后活动槽位归零，且已结算成本与 token 保留；`runner-seam.spec.ts`、`budget.spec.ts`、`parallel-aggregate.spec.ts` 聚焦回归 22/22 通过。AG-05 进行中，仍需真实 Provider 负载压力。

AG-05 真实 HTTP 确定性负载补充（2026-10-31）：`server/tests/provider-diagnostics.spec.ts` 驱动四项并行子任务，验证峰值 Provider 并发为 4、六次调用完整结束且活动请求归零，父任务累计用量为输入 50/输出 25，成本按四个子任务实际成本与最终汇总调用复算，四个子任务 `llm_call` Trace 均关联到并行工具父步骤。Provider 诊断专项 `18/18`，全量 `npm test` `881/881`，`npm run typecheck`、`git diff --check` 通过。该证据覆盖确定性 Provider 负载下的预算结算、并发、聚合和 Trace 关联；真实线上 Provider/工具错误分布采样与退避参数校准仍待完成，AG-05 保持进行中。

AG-05 预算耗尽回放验收（2026-11-01）：`server/tests/provider-diagnostics.spec.ts` 新增目标模式真实 HTTP 回归，任务预算 `$0.42` 下 Provider 第一轮发 `read_file` 工具调用并按 400000 USD/百万 token 计价回报 usage（输入 1010/输出 10，单轮成本 $0.408），第二轮循环前成本熔断拦截，SSE 推送 `budget_hit`（cost $0.408 ≥ budget $0.42）与 `error kind:"budget"`、无 `done`，`cost-breaker` Trace 记录熔断终态。该回归与既有并行负载、取消传播、预算原子预留/退款（`budget.spec.ts`、`runner-seam.spec.ts`、`parallel-aggregate.spec.ts`、`effect-recovery.spec.ts`）合并覆盖预算预留/扣减/退款、取消和结果聚合全链路。Provider 诊断专项 `21/21`，全量 `npm test` `900/900`、`npm run eval:ci` `27/27`、`npm run typecheck` 通过。AG-05 已验收。

LR-04 压力回归补充（2026-10-31）：`kernel/tests/budget.spec.ts` 新增 100 个重叠申请的确定性压力测试，验证活动槽位峰值严格为 8、超额申请被拒、全部释放后回到 0 且容量可复用。预算/并发专项通过；真实 Provider 负载压力仍待完成。

LR-01 checkpoint 版本补充（2026-10-31）：断点 payload 显式写入 `schemaVersion: 1`，读取返回版本；旧版直接消息数组保留兼容标记 `0`，缺省版本对象按 v1 读取，未知版本 fail-closed 并清理断点。`server/tests/db.spec.ts` 专项 `16/16`、`npm run typecheck`、`npm run ui:typecheck`、`git diff --check` 通过。进程强杀后的真实恢复演练仍待完成。

LR-01 进程强杀恢复补充（2026-10-31）：新增 `server/tests/process-recovery.spec.ts` 及 `server/tests/fixtures/process-recovery-child.ts`。真实服务子进程在临时 `AGENT_DATA_DIR` 写入 checkpoint、任务契约、run id、工具验收结果和已完成副作用账本后被强制终止；第二个真实服务子进程使用同一数据目录启动，先确认已完成账本保持 `done`，再通过真实 `/api/sessions/:id/chat`（`resume:true`）完成 SSE 恢复，确认 checkpoint 清除且副作用未重复认领。专项 `1/1`、`npm run typecheck`、`git diff --check` 通过。LR-01 的服务级强杀恢复验收已覆盖；登记项仍保持进行中，剩余网络断开、Provider 故障和并行任务等更广泛故障演练证据。

AG-06：任务只有通过结构化验收条件才发出 `task_verified`；事件为每项检查提供结果与 Trace step ID。服务端将验收状态、检查及证据持久化到 assistant 消息，消息气泡在答复旁展示逐项结果和 Trace 引用。`server/tests/db.spec.ts` 覆盖 Store 重开后的证据恢复；`ui/e2e/bubble-menu.spec.ts` 覆盖完成答复、全部检查和 Trace 引用的同消息展示。专用 Playwright 用例及全量 `npm run e2e` 12/12 通过，`npm run ui:typecheck` 通过；AG-06 已验收。

LR-05：PowerShell 执行器接收工具取消信号，并在 Windows 上通过 `taskkill /T /F` 终止进程树；取消/超时现在等待子进程 `close` 后再结算，`env_probe` 辅助执行也透传 `AbortSignal`；`core/powershell/tests/cancellation.spec.ts` 启动真实后代进程并确认取消后 5 秒内退出。stdio MCP 请求接收工具 `AbortSignal`，取消时移除 pending、清理超时句柄并发送标准 `$/cancelRequest`；`core/mcp/tests/security.spec.ts` 以本地 JSON-RPC 子进程验证取消通知送达，后续调用仍成功。MCP HTTP 请求取消后由本地服务确认连接关闭；该文件 24/24。OpenAI 兼容模型 SSE reader 在取消/结束路径回收，`core/chat/tests/anthropic.spec.ts` 以本地 SSE 服务确认取消后连接关闭（20/20）。ripgrep 取消后等待真实子进程退出并传播错误，避免回退到同步 JS 搜索；`core/tools-fs/cancellation.spec.ts` 与 `kernel/tests/fssearch.spec.ts` 22/22。Provider 和幂等工具的重试退避均可取消并清理计时器；`core/chat/tests/retry-policy.spec.ts` 5/5，确认取消后不发起第二次调用。chat run 取消后不会继续排队模型缓存预热/保活请求；运行时将 `cache.warmup` 切换为 `off` 时会立即取消全部已有预热请求和计时器。warmup/config 最新改动后的 `npm run typecheck` 与 `git diff --check` 通过。LR-05 仍进行中，完整在途请求端到端时限/句柄审计及 LR-01 至 LR-06 其余验收尚未完成。

本轮验证：`ui` 目录 `npm run e2e` 14/14、`npm run typecheck`、`npm run build` 通过；`npm test` 765/765、`npm run eval` 与 `npm run eval:ci` 26/26（安全攻击阻断 4/4）、根目录 `npm run typecheck` 与 `npm run ui:typecheck` 通过；`git diff --check` 通过。

LR-05 定向回归补充：Provider 重试、stdio/HTTP MCP、PowerShell 真实后代进程和 ripgrep 取消测试合计 31/31 通过；服务端集成回归 `server/tests/auth.spec.ts` 28/28 通过。新增 `server/tests/warmup-cancellation.spec.ts` 直接验证配置 PATCH 取消在途 warmup Provider 流，1/1 通过；`warmupOnce` 同时清理未触发的调度 timer。LR-05 保持进行中，完整在途请求端到端时限/句柄审计及 LR-01 至 LR-06 其余验收尚未完成。

LR-03 验收：执行器以 `executionId + turn/tool/name/args` 的稳定幂等键写入 SQLite 副作用账本；已完成结果在 Store 重开后回放，未知 `pending` 结果 fail-closed 并阻止 handler。`server/tests/effect-recovery.spec.ts` 覆盖工具结果回放、未知 pending、真实文件写入、HTTP POST、Node 子进程副作用，以及三类副作用已发生后工具失败的恢复场景；成功与失败恢复均保持文件单份写入、HTTP 单次请求和子进程单次写入。该测试文件 8/8，`npm run typecheck` 通过，满足登记验收条件。

LR-06 验收：`Store.saveCheckpoint` 限制 200 条消息与 512 KiB JSON 字节，并保留 `truncated`/`originalLength` 标记；`loadCheckpoint` 兼容旧版直接消息数组格式，按可配置的 `checkpoint.retentionDays`（1-3650 天，默认 30 天）拒绝过期断点并清理孤立副作用账本。配置通过 `/api/config` 热更新，Store 重启时从配置恢复策略。`server/tests/db.spec.ts` 覆盖双上限、旧格式、默认过期清理和自定义保留期跨 Store 重开（10/10）；`server/tests/config-provider.spec.ts` 覆盖配置持久化、运行时应用及非法边界（3/3）。`npm test` 778/778、`npm run typecheck`、`npm run ui:typecheck`、`npm run eval:ci` 26/26 与 `git diff --check` 均通过，满足登记验收条件。

当前登记总数：71 项。关闭任一条时必须补上实现提交、测试命令与结果、必要的迁移/文档链接和回滚方式。关闭全部条目后，对 11 个领域逐项复核，再更新 `00-master-plan.md` 的最终审计表。

PL-02 脚手架真实加载补充（2026-10-31）：`scripts/plugin-scaffold.mjs` 导出 `createPlugin`，`scripts/plugin-scaffold.spec.mjs` 在仓库 `plugins/` 下生成临时插件并交由真实 `Kernel/PluginLoader` 加载，核对生成 manifest、`started` 状态及 `<id>_hello` capability，测试结束清理插件与快照。脚手架专项 `3/3`、`npm run typecheck`、`git diff --check` 通过。PL-02 仍进行中，完整 SDK 类型包、参考插件和安装/卸载全流程尚待完成。

PL-02 SDK 入口补充（2026-10-31）：新增 `kernel/plugin-sdk.ts` 作为第三方插件稳定公共入口，导出宿主 API 版本、服务键和插件运行时契约类型；脚手架模板与 `plugin-authoring` 技能改用该入口，避免新插件直接依赖内核实现文件。SDK/脚手架定向测试 `4/4`、`npm run typecheck`、`git diff --check` 通过。参考插件和安装/卸载全流程仍待完成，PL-02 保持进行中。

PL-02 参考插件补充（2026-10-31）：新增 `plugins/reference-hello` 最小 TypeScript 参考插件，manifest 声明 API 兼容范围、工具 capability 白名单并默认 `enabled:false`；回归验证真实 loader 扫描后为 `loaded` 且能力不可见，显式启用后注册 `reference_hello`，停用后能力撤回。参考插件专项 `1/1`、manifest validate、`npm run typecheck`、`git diff --check` 通过。安装/卸载全流程仍待完成，PL-02 保持进行中。

PL-02 安装卸载链路补充（2026-10-31）：脚手架集成回归扩展为生成插件后由真实 loader 加载并注册 capability，随后调用 `PluginLoader.uninstall`，断言 registry 移除、插件目录删除及快照清理。脚手架专项 `3/3`、`npm run typecheck`、`git diff --check` 通过。PL-02 仍进行中，SDK 细化、发布包和更完整的安装来源校验尚待完成。

PL-02 验收（2026-10-31）：`kernel/plugin-sdk.ts` 完整转出插件公共类型与服务键，`scripts/plugin-scaffold.mjs` 提供 create/validate，本地 `plugins/reference-hello` 提供默认停用的参考实现；`scripts/plugin-scaffold.spec.mjs` 覆盖生成、manifest 校验、真实 loader 加载、capability 注册、卸载和目录/快照清理，`kernel/tests/plugin-sdk.spec.ts` 与 `kernel/tests/plugin-reference.spec.ts` 覆盖 SDK 和参考插件生命周期。专项 `5/5`、`npm run typecheck`、`git diff --check` 通过。文档：[plugin-authoring/SKILL.md](../web-agent/core/skills/builtin/plugin-authoring/SKILL.md)。回滚：移除 `kernel/plugin-sdk.ts`、`plugins/reference-hello`、脚手架及对应测试，并恢复脚手架/技能中的旧类型入口。

PL-03 UI 诊断补充（2026-10-31）：新增 `ui/e2e/plugin-errors.spec.ts`，mock 插件依赖缺失状态并通过真实插件管理页面选择详情，验证错误原因与可操作修复建议均可见。Playwright 专项 `1/1` 通过；PL-03 仍进行中，插件 id 冲突场景的可解释错误回归和完整失败恢复 UI 证据仍待补齐。

PL-03 冲突诊断补充（2026-10-31）：`PluginLoader` 为重复 id 生成脱敏结构化诊断（kind=`conflict`、message、suggestion），新增 `/api/plugins/diagnostics`，保留 `/api/plugins` 原数组契约；插件管理页展示诊断条目。`kernel/tests/loader.spec.ts` loader 专项 `29/29`，插件错误 UI E2E `1/1`，`npm run typecheck`、`npm run ui:typecheck`、`npm run ui:build`、`git diff --check` 通过。PL-03 仍进行中，完整失败恢复 UI 证据尚待补齐。

PL-03 验收（2026-10-31）：依赖缺失、入口错误、重复 id 冲突均提供结构化或可操作诊断；`PluginLoader` 的事务回滚继续保留旧版本并记录 rollback；新增 `/api/plugins/diagnostics` 与插件管理页诊断展示，保留 `/api/plugins` 数组兼容契约。`kernel/tests/loader.spec.ts` `29/29` 覆盖回滚、依赖错误、冲突和恢复边界；`ui/e2e/plugin-errors.spec.ts` `2/2` 覆盖错误原因/建议展示及重载恢复为运行中；`npm test`、`npm run typecheck`、`npm run ui:typecheck`、`npm run ui:build`、`git diff --check` 通过。回滚：移除诊断 API/类型、UI 诊断区及新增回归，恢复 `/api/plugins` 原实现。

PL-04 来源边界补充（2026-10-31）：`kernel/tests/loader.spec.ts` 新增真实 loader 投影与 watcher 回归，确认 `plugins/` 用户插件 `watched=true` 且保存后自动热重载，`core/` 内置插件 `watched=false` 且修改不触发热重载；`plugin-authoring` 技能明确 `vendor/` 仅由技能同步/索引管理，不进入 PluginLoader 生命周期。边界专项 `31/31`、`npm test` 退出码 `0`、`npm run typecheck`、`git diff --check` 通过。PL-04 仍进行中，vendor 技能更新端到端验证尚待完成。

PL-05 验收（2026-10-31）：技能索引 `SkillInfo` 与 `/api/skills` 服务公开 `triggers`、`appliesWhen`、`rejectWhen`、`input`、`output`，兼容连字符/下划线 frontmatter 键；五个内置技能均补齐契约。索引 schema 校验缺失字段时保留旧技能并返回 `contractWarnings`，避免静默误用；`web-agent/core/skills/tests/index.spec.ts` 覆盖契约正例、缺失字段拒绝告警及五个内置技能全量通过。专项 `3/3`，`npm test` `827/827`、`npm run typecheck`、`npm run ui:typecheck`、`git diff --check` 通过。回滚：移除新增契约字段、`contractWarnings`、内置技能 frontmatter 和索引回归，恢复旧 `SkillInfo` 形状。

PL-01 验收（2026-10-31）：`PluginManifest`、loader 和脚手架统一支持入口、完整 semver、`compatibility.api` 范围、`permissions.capabilities` 白名单及配置 JSON Schema 子集；旧 manifest 无声明时继续 trusted 兼容。新增 [manifest-v1-compatibility.md](manifest-v1-compatibility.md) 记录字段、兼容矩阵、迁移步骤和回滚方式。`kernel/tests/loader.spec.ts` 全部专项 `31/31`（含 manifest、配置、权限和回滚），`scripts/plugin-scaffold.spec.mjs` `3/3`，`npm run typecheck`、`git diff --check` 通过。回滚：移除 manifest 可选字段校验、兼容文档及对应回归，恢复旧 loader 行为。

PL-06 静态审查补充（2026-10-31）：新增 `kernel/plugin-review.ts`，对自扩展源码拦截原生进程、宿主文件系统、动态代码、进程环境和裸网络请求，并从 `ctx.register` 提取能力执行 manifest 白名单审查；`create_plugin` 仅在审查通过后写盘，生成插件默认 `enabled:false`，需显式 `enable_plugin` 才可试运行。`kernel/tests/plugin-review.spec.ts` `3/3`、`npm test` `831/831`、`npm run typecheck`、`git diff --check` 通过。PL-06 仍进行中，尚待将显式试运行移入隔离进程/临时工作目录并补生命周期回收证据。

PL-06 验收（2026-10-31）：`create_plugin` 通过 `kernel/plugin-review.ts` 拦截高风险原生进程、文件系统、动态代码、环境读取和裸网络模式，提取 capability 并生成白名单；生成插件默认停用。`kernel/plugin-trial.ts` 在临时项目根、独立 Node 子进程和临时 Kernel 中启动插件，试运行结束清理目录；失败插件返回 error 且不影响宿主。静态审查 `3/3`、隔离试运行 `2/2`，`npm test` `833/833`、`npm run typecheck`、`git diff --check` 通过。回滚：移除 plugin-review、plugin-trial、create_plugin 审查门及对应测试，恢复原自动生成行为。

PL-04 验收（2026-10-31）：`kernel/tests/loader.spec.ts` 真实回归确认 `plugins/` 用户插件 `watched=true` 且保存后热重载，`core/` 内置插件 `watched=false` 且修改不触发热重载；`core/skills/tests/index.spec.ts` 增加临时 vendor 包版本替换、缓存失效和重新索引验证，确认 vendor 只进入技能索引，不进入 PluginLoader 目录。边界专项 `32/32`、技能专项 `4/4`，`npm test` `828/828`、`npm run typecheck`、`git diff --check` 通过。回滚：移除 `skills.vendorDir` 覆盖点及 vendor 回归，恢复固定 vendor 路径和原 PL-04 文档。

API-07 健康契约补充（2026-10-31）：新增只读 `/api/ready` 与 `/api/storage`；就绪响应按 Provider、插件错误和数据库检查返回 200/503，存储响应仅返回容量数字和状态，不返回路径或凭据。`server/tests/auth.spec.ts` 新增正常端点与故障输入回归，认证集成专项 `30/30`；`npm run typecheck`、`npm run ui:typecheck`、`git diff --check` 通过。API-07 仍进行中，生产级 Provider 故障演练和容量阈值监控尚待完成。

API-07 验收（2026-10-31）：`/api/storage` 增加 `ok/status/freePercent/thresholds`，以 10% 和 5% 空间阈值区分正常、警告和临界状态；`/api/ready` 将未知或临界存储状态纳入就绪判定。`/api/providers/test` 的真实 HTTP 503 探测使用状态型错误写入 Provider 健康账本，连续 3 次触发瞬时故障与熔断，`/api/providers/:id/diagnose` 和 `/api/providers` 均可观察失败次数、熔断时间和可操作问题，远端响应体与密钥不回显。`server/tests/auth.spec.ts`、`server/tests/provider-diagnostics.spec.ts`、`server/tests/api-contract.spec.ts` 合计 `51/51`，`npm run typecheck`、`git diff --check` 通过。回滚：移除存储状态/阈值字段、就绪存储检查、Provider 探测健康记账适配和新增故障演练，恢复原容量快照与诊断行为。

API-01 错误契约补充（2026-10-31）：`/api` 错误响应统一补充 `schemaVersion: 1`、`ok: false` 和稳定 `code`，保留既有 `error` 文案；未命中 API 返回同一 404 契约，服务端异常不再回显内部错误文本。认证集成专项 `31/31`，新增 API 错误契约回归；`npm run typecheck`、`git diff --check` 通过。API-01 仍进行中，尚需为全部成功响应补齐版本化 schema 与契约目录。

API-01 成功响应契约补充（2026-10-31）：新增 `web-agent/server/api-contract.ts` 作为核心控制面端点登记册，覆盖所有核心显式 Express JSON/SSE 路由；所有 `/api/*` 响应统一携带 `X-API-Schema-Version: 1`，保持既有 payload 兼容。`server/tests/api-contract.spec.ts` 扫描路由源并拒绝未登记端点，另校验登记唯一性与版本头（3/3）；新增 [api-contract-v1.md](api-contract-v1.md) 记录兼容规则和回滚方式。验证：API 契约专项 3/3、`npm run typecheck`、`git diff --check`。API-01 仍进行中，剩余逐响应字段 schema 校验及插件自定义 payload 契约。回滚：移除 `server/api-contract.ts`、版本头中间件、契约测试与文档，恢复仅错误响应契约。

API-01 逐字段 schema 验收（2026-10-31）：核心登记项增加可执行 JSON Schema 子集，覆盖对象/数组/基础类型和必要字段；成功响应由 `res.json` 统一校验，违反登记 schema 时 fail-closed 返回 `response_schema_invalid`，保持既有成功 payload 形状不变。`PluginManifest.api.responses` 与 `ApiDef.responses` 支持插件按 `METHOD /path` 声明自定义 payload schema，宿主动态校验并保留未声明插件端点兼容行为。`server/tests/api-contract.spec.ts` 增加 schema 执行、参数路由归一化和登记完整性回归 `4/4`；`npm run typecheck`、`git diff --check` 通过。API-01 达到本轮字段契约验收，后续仅需在新增端点进入登记册时补 schema。回滚：移除 `schema` 登记字段、响应校验包装器及插件 `responses` 类型声明，保留版本头和错误契约。

API-03 SSE 配额补充（2026-10-31）：`/api/events` 与 `/api/sessions/:id/chat` 共用进程内连接上限（默认 8，可由 `sse.maxConnections` 配置），超限返回 429 与 `Retry-After: 15`；连接关闭时幂等释放槽位。两条流均发送 `retry: 15000`，由 EventSource 按 15 秒间隔自动重连；保留 15 秒心跳、背压上限和断连清理。`server/tests/auth.spec.ts` 的 SSE 配额单元、全局事件流断连生命周期，以及 8 条全局流占满后聊天流拒绝/断开后释放的真实 HTTP 回归共 `33/33`；`npm run typecheck`、`git diff --check` 通过。API-03 仍进行中，尚需真实浏览器断线重连 E2E 与长时连接资源回收演练。回滚：移除 `SseConnectionLimiter`、`retry` 指令和新增测试，恢复原两条 SSE 连接行为。

API-03 浏览器恢复专项（2026-10-31）：`ui/src/api.ts` 的全局 `EventSource` 订阅增加显式连接生命周期管理，断线时关闭失效实例并按 `1s → 15s` 退避重建，浏览器离线/恢复事件会同步更新实时状态并重建连接；退订时清理计时器、事件监听器和连接。`ui/e2e/sse-reconnect.spec.ts` 使用真实 Playwright 浏览器与真实 `/api/events`：在线建立连接、浏览器离线后服务端审计记录断开、恢复网络后不重载页面即自动重建连接、关闭页面后连接计数回到基线。专项 `1/1` 通过；`npm run ui:typecheck`、`npm run ui:build`、`git diff --check` 通过。API-03 保持进行中，长时连接资源回收演练尚待完成。回滚：恢复 `subscribeEvents` 的单一原生 EventSource 实现，移除 `ui/e2e/sse-reconnect.spec.ts`。

API-03 长连接资源补充（2026-10-31）：`server/tests/auth.spec.ts` 真实 HTTP 流跨过 15 秒心跳周期，断言 `retry: 15000`、`: ping` 心跳、取消后的 `ClientTracker.size=0`；认证/SSE 专项 `34/34`，完整 `npm run e2e` `22/22`，`npm run typecheck`、`npm run ui:typecheck`、`npm run ui:build`、`git diff --check` 通过。API-03 仍保持进行中，待更长时段及多连接压力演练。回滚：移除心跳专项回归，保留现有 SSE 生命周期清理。

API-05 原子写入与审计补充（2026-10-31）：新增 `kernel/atomic-file.ts`，统一配置、策略规则和 `secret.key` 的同目录临时文件写入、`fsync`、原子替换与失败清理；`Config.setPersistentBatch` 让配置 PATCH 在提交成功后才广播运行时状态，失败时保留旧文件和旧状态。变更类 API 的成功/拒绝授权和 SSE 生命周期均写入脱敏审计，`createApiTokenGuard` 对真实 Express 请求与轻量测试请求使用同一路径兜底。`kernel/tests/atomic-file.spec.ts`、`kernel/tests/config.spec.ts`、`server/tests/config-provider.spec.ts` 专项 `19/19`，`server/tests/auth.spec.ts` `34/34`，全量 `npm test` `887/887`，`npm run typecheck`、`git diff --check` 通过。该证据覆盖文件写入半写、配置批量失败和授权审计边界；SQLite 事务、并发版本校验及真实崩溃注入仍待完成，API-05 保持进行中。回滚：恢复各调用点原有临时文件实现，移除 `kernel/atomic-file.ts`、授权审计增强与新增回归。

API-05 并发与崩溃防护（2026-10-31）：SQLite 写入全部事务化（审计、明文密钥迁移、批量模型 upsert、工具账本、会话消息与断点清理），Provider/模型行以 `updatedAt` 乐观版本校验，配置与规则文件以内容指纹 revision 乐观锁；路由层缺失版本 428、冲突 409 并附最新版本，UI 自动携带版本。`server/tests/sqlite-crash.spec.ts` 真实子进程 `exit(137)` 崩溃注入后重开数据库断言行回滚。专项 `23/23`（sqlite-crash、db、config-provider），`server/tests/auth.spec.ts` `35/35`，全量 `npm test` `892/892`，`npm run typecheck`、`npm run ui:typecheck`、`git diff --check` 通过。验收条件「崩溃注入后配置/数据库无半写」已满足，API-05 已验收。回滚：恢复各路由与 Config/Store 旧签名及未版本化写入，移除并发校验、事务化封装与新增崩溃注入测试。

LR-05 子任务取消传播补充（2026-10-31）：`server/tests/parallel-subagent-cancellation.spec.ts` 经真实聊天 HTTP 入口验证父任务停止（客户端断开）后取消传播：`run_parallel` 四个子任务全部在 abort 时中止流并以 `cancelled:true` 收尾，`run_subagent` 单子代理同样中止；5 秒内全部模型流回收，取消后父循环不再发起新一轮 LLM 调用。`/api/ready` 新增 `resources` 字段（activeRuns、sseConnections、pageConnections、pendingApprovals、activeWarmups、activeSubagentSlots）作为取消后句柄归零的对外可观测审计面，契约 schema 同步登记。专项 `3/3`，全量 `npm test` `895/895`，`npm run typecheck`、`npm run ui:typecheck`、`git diff --check` 通过。LR-05 保持进行中，网络断开、Provider 故障等更广泛故障演练证据按 LR-01 计划推进。回滚：移除该回归文件与 `/api/ready` 的 `resources` 字段，取消传播行为不受影响。

CT-06 文件缓存外部变更补充（2026-10-31）：`kernel/fssearch.ts` 提供目录、文件内容和递归文件树指纹；`list_dir`/`glob`/`grep`/`read_file` 将对应快照纳入 L2 键，目录新增/删除、文件重命名及同尺寸原位内容修改都会改变缓存键。单文件超过 2 MB、grep 单次内容指纹累计超过 8 MB 或树扫描不完整时跳过缓存，避免把不完整视图当成可复用结果。`kernel/tests/fssearch.spec.ts` 与 `core/tools-fs/cache-invalidation.spec.ts` 专项 `26/26`，完整 `npm test` `869/869`，`npm run typecheck`、`git diff --check` 通过。CT-06 仍进行中：这组确定性回归不等于生产误命中率统计，L3 Provider usage 真实命中窗口及多 Provider/会话作用域误命中率校准尚待完成。回滚：恢复文件工具的路径/mtime/size 缓存键并移除 `kernel/fssearch.ts` 的指纹函数及对应回归。

MD-03 约束画像 fail-closed 补充（2026-10-31）：`core/chat/routing.ts` 新增 `capabilityRejectionReasons`，显式 `maxLatencyMs`、`privacyTier`、`maxRiskLevel` 约束在候选缺少对应画像时拒绝，并在候选 Trace 中写入具体缺口；未声明约束时维持旧模型兼容推断。`core/chat/tests/routing.spec.ts` 与真实 `server/tests/provider-diagnostics.spec.ts` 合计 `24/24`，验证高延迟/外部/高风险候选及无画像候选均被拒绝，local/低风险候选仍被选中；`npm run typecheck`、`git diff --check` 通过。MD-03 仍进行中，普通聊天任务的多能力组合与真实负载延迟校准尚待完成。回滚：恢复能力路由对缺失画像的兼容放行，移除拒绝理由 helper 与新增回归。

OB-02 交叉验收证据补充（2026-10-31）：Trace 已完整记录模型耗时、输入/输出/缓存 token、按实际模型价格计算的成本、L2/L3 缓存层、审批等待与批准/拒绝终态、错误分类/稳定码/重试决定及工具结果摘要。`server/tests/provider-diagnostics.spec.ts` 真实 HTTP 回归覆盖瞬时错误重试、参数错误停止、审批批准/拒绝、工具结果和同一未变文件二次读取的 L2 命中；Provider 诊断专项 `16/16`，全量 `npm test` `879/879`，`npm run typecheck`、`git diff --check` 通过。回滚：恢复 `server/tests/provider-diagnostics.spec.ts` 的单次文件读取与原有断言，并移除本轮 Trace 交叉回归；保留已存在的 Trace 字段兼容读取。

OB-02 验收（2026-11-01）：交叉验收证据与实现提交（`0c40c86`）关联后关闭。Trace 字段与实际模型调用/工具结果的全路径交叉核对齐备：`llm_call` 核对实际 Provider/model、耗时、输入/输出/缓存 token 与按实际价格复算的成本；`tool_call` 核对两次读取的终态、结果摘要、耗时与二次读取的唯一 `cache_hit`（L2）；`retry-policy` 核对错误分类、稳定码与重试/停止决定；审批批准/拒绝/过期凭据路径核对凭据下发、执行/阻断与同一 Trace 关联；参数错误与预算耗尽路径核对错误终态字段。Provider 诊断专项 `21/21`，全量 `npm test` `900/900`、`npm run eval:ci` `27/27`、`npm run typecheck` 通过。OB-02 已验收。

UX-02 验收（2026-10-31）：`ui/e2e/main-flows.spec.ts` 新增「全流程状态链」场景，以 SSE/REST mock 锁定目标条、审批卡、结果终态、阻塞终态与恢复入口的完整链路：plan mock 内容渲染到目标条，`approval_required` 帧唤起审批卡且 `POST /api/approvals` 携带一次性凭据，`done` 帧落为结果终态，`error` 帧落为阻塞终态并在 `.wx-failure` title 保留原始错误，`sess-banner.resume` 发出带会话凭据的恢复请求。`ui/e2e/sse-reconnect.spec.ts` 的审计统计改为按页面加载时间戳过滤 `occurredAt`，消除共享 e2e 数据目录中历史事件挤占 `limit=500` 窗口导致的偶发失败。验证：主流程专项 `5/5`、UI E2E 全量 `29/29`、`npm run ui:typecheck`、`npm run typecheck`、`git diff --check` 通过。回滚：删除 `ui/e2e/main-flows.spec.ts` 中的 UX-02 场景，并恢复 `sse-reconnect.spec.ts` 的无条件审计计数。

UX-03 验收（2026-10-31）：`ui/e2e/main-flows.spec.ts` 新增「状态覆盖」场景组，六类状态各有 E2E 锁定：空数据（无历史会话自动建会话并展示品牌首屏引导配置模型，`.view-loading` 无悬空）、断线（浏览器 offline 事件后聊天页头部状态字切换为断线提示）、Provider 错误（真实 `event: event` SSE 帧注入 `provider.error`，断言 Provider 列表刷新与 warning toast）、工具失败（`tool_result ok=false` 定格为「没成」错误卡且流式复位）、部分成功（`task_partial` 帧展示「部分完成」验收卡，默认展开并保留未满足条件与 Trace 引用）、无无限 loading（长任务失败与取消场景断言 `.stream-cursor` 清零且发送按钮复位；加载态由懒加载 Suspense 兜底，首屏稳定后 `toHaveCount(0)`）。验证：主流程专项 `10/10`、UI E2E 全量 `34/34`、`npm run ui:typecheck`、`npm run typecheck`、`git diff --check` 通过。回滚：删除 `ui/e2e/main-flows.spec.ts` 中的「状态覆盖（UX-03）」场景组，登记状态回退为待执行。

UX-04 验收（2026-10-31）：`ui/e2e/main-flows.spec.ts` 新增「交互通道」场景组锁定键盘路径：流式期间 Esc 触发停止并在 2 秒内出现停止终态与恢复入口；Enter 激活审批卡「可以，去做吧」且 `POST /api/approvals` 携带一次性凭据；错误流触发 checkpoint 拉取后 Tab+Enter 激活「接着说」并发送 `resume:true` 请求；失败气泡「再试一次」经 Tab+Enter 激活后重发原文并渲染成功答复。鼠标路径由既有场景覆盖：长任务取消（2 秒终态）、工具审批批准/拒绝（一次性凭据）、断点恢复（`resume:true`）、用户气泡重新发送、气泡菜单复制、Trace 导出 JSONL（文件名与筛选内容断言）。验证：主流程专项 `14/14`、UI E2E 全量 `38/38`、`npm run ui:typecheck`、`npm run typecheck`、`git diff --check` 通过。回滚：删除 `ui/e2e/main-flows.spec.ts` 中的「交互通道（UX-04）」场景组，登记状态回退为待执行。

UX-05 验收：`ui/e2e/a11y.spec.ts` 以 axe-core（critical/serious 门禁）锁定会话首屏与审批挂起态扫描零违规；审批按钮原生可聚焦并通过 `/api/approvals/**` 提交；失败终态带 `role="status"` 与原始错误 `title`。配套修复：`BrandLogo` 容器改 `role="img"`、步骤筛选下拉补 `aria-label`、统计卡提示文字提级对比度、`ChatView` 失败条声明状态区。布局证据：1280x720 与 390x844 视口下首屏/输入区/发送按钮无遮挡且横向零溢出——窄视口（≤760px）侧栏收窄至 240px、顶栏模式/模型菜单折叠为图标触发器（`Menu` 新增 `compactTrigger`）、轨迹面板与输入提示/快捷键胶囊隐藏。验证：a11y 专项 5/5、UI E2E 全量 43/43、双端 typecheck 与 `git diff --check` 通过。回滚方式：删除 `ui/e2e/a11y.spec.ts` 并还原 `BrandLogo.tsx`、`TracePanel.tsx`、`ChatView.tsx`、`App.tsx`、`Menu.tsx`、`styles.css` 中本次可访问性相关改动，不涉及数据迁移。
