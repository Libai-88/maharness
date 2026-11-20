# maharness 全面质量审查

审查日期：2026-11-19  
审查对象：`D:\DEEPSEEK\maharness`（`maharness` 分支，HEAD `dcd9ce3`）  
审查方式：只读代码、文档、测试、导入关系与 CI 证据核对；未修改产品源码。  
范围：内核与插件边界、server 宿主层、AI 社会与劳动组织、AI 用户复盘/自进化、测试与工程化、安全与持久化。

## 一、总体结论

maharness 已经不是早期原型：它有真实的 Run 执行链、恢复账本、租户隔离、审批、预算、迁移备份、1525 个通过的单测、402 项安全回归、133 条浏览器 E2E，以及双 workflow 绿的 CI。**工程纪律明显高于同类“AI 产品原型”**。本次审查未发现可直接远程利用的 P0 安全缺陷；问题集中在架构边界、语义准确性和可维护性。

但用户担心的两件事都成立：

1. **架构重心已经从 kernel/core 漂移到 server 宿主层。** “全插件化”目前只对 `core/` 成立；AI 社会、劳动组织、复盘、自动化、事项等产品能力是 `server/` 里的不可卸载单体模块。
2. **AI 社会目前是一个可审计的角色调度与劳动组织系统，不是“像真实人类社会一样”的社会模拟。** 它有人类设定的制度、角色、契约、预算、审计和福利约束，但角色关系、记忆、健康度等社会指标主要由确定性规则和启发式生成，概念名称大于实际语义。

这不是“代码质量崩了”，而是**产品复杂度和架构边界没有同步收敛**。在继续增加功能之前，建议先做一轮架构收敛。

| 维度 | 判断 |
| --- | --- |
| Kernel 与 core 的源码依赖方向 | 良好，kernel 源码不引 core/server |
| “全插件化” | 部分成立，产品能力集中在 server |
| 插件 SDK / API 3.0 | 名义存在，实际公共边界不足 |
| AI 社会概念与实现一致性 | 中等偏弱，需重新界定产品语义 |
| 测试广度与 CI | 强 |
| 安全、租户、持久化 | 强 |
| 可维护性 | 中等，超大文件与启发式逻辑较多 |
| 性能/规模 | 本地单用户可接受，扩张前需重构 |

## 二、做得好的地方

- **内核边界确实被测试守住。** `kernel/tests/dependency-boundary.spec.ts` 禁止 kernel 源码依赖 core/server/ui；实际核对也确认 kernel 源码没有跨层 import。
- **执行可靠性投入很重。** Run 状态机、检查点、工具副作用账本、恢复、取消传播、审批等待、租户隔离都有专门实现和测试；这些是很多 Agent 产品缺失的部分。
- **安全不是口号。** 审批一次性凭据、API token、部署模式、SSRF、路径沙箱、MCP/插件权限、凭据失败限流都有测试；`npm run test:security` 为 402/402，生产依赖审计为前后端 0 漏洞。
- **测试与 CI 是真实资产。** 1525 个单测通过（2 个按环境跳过）、selftest 90/90、确定性回放 28/28、优化回归 108/108、E2E 133/133；GitHub Actions quality + e2e 双绿。
- **自进化是保守的。** 复盘只能形成问题池和建议，经验问题进入技能提案前有人类门槛；模型不能直接改权限、规则、技能、测试或代码。这是正确的安全方向。
- **文档对边界基本诚实。** `AI-ORGANIZATION.md` 明确写了“自由聊天式群体、虚拟情感关系和无人监管的自治不属于当前产品边界”，没有把调度器包装成社会模拟。

## 三、主要发现

### F1（架构级 P1）产品能力退回 server 单体，“全插件化”名不副实

**证据**

- 排除测试与插件快照后：kernel 11,378 行、core 16,223 行、server 19,465 行、ui 17,877 行。server 已是最大源码层。
- `server/society.ts` 2,531 行 / 126 KB；`server/organization.ts` 1,849 行；`server/organization-store.ts` 1,649 行；`server/experience.ts` 1,620 行；`server/db.ts` 1,503 行。
- server 侧共有 56 张 `CREATE TABLE` 表、29 个 route 文件；社会/组织/复盘/自动化是互不独立的宿主模块。
- `server/society.ts` 直接依赖 `OrganizationService`、`RunService`、`Store`；`server/routes/index.ts` 同时装配这些服务。

**影响**

- 无法像插件一样独立卸载、替换或回滚 AI 社会/复盘/自动化；任何制度调整都会触及 server 的单体状态机。
- `kernel/` 的薄边界仍然存在，但“薄内核 + 全插件化”的整体承诺被宿主层吞掉了。继续扩张会让 server 成为第二个内核。

**建议**

1. 先定义明确的两类扩展：**host service（必须随宿主运行）** 与 **plugin（可独立装卸）**。
2. 把 AI 社会拆成独立 host service 包或插件：`society-scheduler`、`organization-contracts`、`social-metrics`、`society-store`，通过显式接口连接 RunService/Store。
3. 在架构文档中把“全插件化”改写为“内核插件化 + 宿主服务边界”，不要用口号掩盖宿主复杂度。

### F2（架构级 P1）Plugin SDK 不是真正的公共边界

**证据**

- `kernel/plugin-sdk.ts` 只导出 `PLUGIN_API_VERSION`、`SERVICE_KEYS` 和类型；没有运行时辅助、没有插件生命周期工具，也没有稳定服务契约。
- 排除快照后，115 个 core 源码文件中 **69 个**直接深引 `kernel/*`；只有 self-extend 的 `sdk.ts`/`examples.ts`（外加一个测试）使用 `kernel/plugin-sdk`。
- 仓库自带插件 `plugins/workbench/index.ts` 直接 `import type { Plugin } from '../../kernel/types'`，与脚手架生成的 SDK 路径不一致。
- server 也直接引了 core 内部实现：`server/index.ts`（`globalApprovalBoard`、`discoverProviders`）、`server/organization.ts`（`currentPlanForSession`）、`server/experience.ts`（`redactTraceValue`）。

**影响**

- 插件清单写着 API `3.0.0`，但插件的实际编译依赖是 kernel 内部文件路径；kernel 内部重构会静默破坏第三方插件。
- 同一份“插件 API”在 core、仓库插件、外部插件之间没有统一入口，版本契约无法真正执行。

**建议**

- 扩充 `kernel/plugin-sdk` 为唯一公共入口：插件类型、服务 key、生命周期辅助、已稳定的策略类型。
- 增加边界测试/ESLint `no-restricted-imports`：`core/**` 与 `plugins/**` 禁止直接 import `kernel/*`（除 SDK 与明确豁免）。
- 迁移 `plugins/workbench` 与 core 到 SDK；为 server→core 的 4 条依赖补 host 接口或 service 封装。

### F3（AI 社会 P1）角色选择和社会指标依赖关键词/固定权重，呈现精度高于事实精度

**证据**

- `server/society.ts:285` 的 `ROLE_SELECTION_WEIGHTS` 是硬编码常量；`selection.policyVersion` 记录了制度版本（`server/society.ts:1258`），但 `InstitutionPolicies`（`server/organization-store.ts:410-425`）没有包含这六个权重。
- `requiredCapabilities` 用中英文关键词/别名从任务文本里猜能力（`server/society.ts:734-757`）；`taskNeedsWrite` 用“创建/生成/修改/导出/写入”等正则判断写权限（`server/society.ts:759-771`）。
- `memoryRelevance` 只是把能力词与角色记忆摘要做小写子串匹配（`server/society.ts:790-795`）。
- `collaborationHealth` 来自交流关系平均分；团队完成时给所有角色对统一写 `0.9`，人工拒绝时统一写 `0.2`（`server/society.ts:1969-1975`、`2042-2051`）。
- `snapshot` 的 `health.score` 是 `loadBalance`、`welfare`、`exceptionHealth`、`1 - budgetUtilization`、`collaborationHealth` 的等权平均（`server/society.ts:2125-2130`），UI 直接展示为 `/100`（`ui/src/components/WorkbenchView.tsx:390`）。

**影响**

- 角色选择可能对任务语言、同义词和写法敏感；中英文/新业务词容易误判能力和写入需求。
- “协作健康”“社会健康 92/100”看起来像客观测量，实际权重和关系分数没有校准依据；这会误导用户对制度效果的判断。
- 选择记录显示 `policyVersion`，但真正的选择权重不在制度版本中；审计语义不完整。

**建议**

- 用显式的任务能力声明或任务 schema 替代关键词猜测；至少把能力别名表做成可测试、可分语言的数据，而不是散落在文本匹配里。
- 把六因子权重纳入 `InstitutionPolicies`，与制度版本一起审计、回滚；或在 UI 和 API 中明确标注为运行时固定权重。
- 关系分数必须有可核对的来源（具体交接、冲突、复核事件），不要按结果批量赋值；对未样本角色显示“未知”，不要显示伪精确分。
- 社会健康分要么给出公式、分母、样本量和校准依据，要么降级为“观察指标”而不是 `/100` 评分。

### F4（可靠性 P1）社会状态机依赖真实时间，CI 抖动已暴露

**证据**

- `server/society.ts` / `server/organization.ts` 共有 43 处 `Date.now()`，服务没有注入 clock；而 `ExperienceService` 已通过 `deps.now` 注入，`Scheduler` 也接受 `now`。
- `server/tests/society.spec.ts` 大量使用 `Date.now()` 和 `setTimeout`；E2E 的 `society-real-backend.spec.ts` 在 CI 上曾因等待窗口不足失败，我们本次只能通过固定 `workers: 1` 和放宽等待来稳定。
- `society.ts` 的 `tick` 会遍历最多 1,000 个 schedule/task，并反复实例化服务；`snapshot`/`roleLife` 也走同样路径。

**影响**

- 状态机测试不是确定性的；本地通过不代表 CI 通过，时间相关缺陷可能被等待掩盖。
- 在真实负载或慢机器上，调度可能错过状态窗口，或产生不一致的中间态。

**建议**

- 为 `SocietyService`/`OrganizationService` 注入统一 `Clock`，测试使用假时钟；禁止业务层直接 `Date.now()`（可用 lint 规则）。
- 为调度器编写性质测试：pending→scheduled→active→awaiting_acceptance/failed/collapsed 的合法迁移、预算/配额不变量、重启幂等。
- E2E 等待改为事件驱动（run.updated / society.released），不要靠 sleep/长超时。

### F5（可维护性 P2）超大文件和重复装配，修改成本正在上升

**证据**

- `server/society.ts` 2,531 行；`organization.ts` 1,849 行；`organization-store.ts` 1,649 行；`experience.ts` 1,620 行；`kernel/plugin-loader.ts` 2,023 行。
- `society.ts` 中源码出现 6 次 `new OrganizationService`：构造函数、`rankRoles`、`tick`、`snapshot`、`roleLife` 等热点路径；`society.ts` 有 159 处 `this.repository()` 调用。
- UI：`App.tsx` 976 行、`SettingsView.tsx` 952 行、`WorkbenchView.tsx` 689 行。
- 仓库没有 ESLint/Prettier/Biome 配置，`package.json` 没有 coverage 脚本；质量主要靠 `tsc` + node:test + E2E。

**影响**

- 一个制度/调度变更需要同时改 service、store、routes、UI，回归面大。
- 重复构造服务会重复计算 evaluation/scorecards/wellbeing，快照之间可能不一致，也会放大延迟。

**建议**

- 把 `society.ts` 拆为：`selection`（角色评分/能力解析）、`scheduler`（tick/queue）、`settlement`（交付/回退/审计）、`snapshot`（只读投影）四个模块。
- 每个 RunService/HTTP 请求只构造一次 `OrganizationService`，或由依赖注入容器持有；为 tick/snapshot 增加缓存与查询上限。
- 引入 ESLint/Biome 与变更覆盖门槛；为 UI 大组件建立拆分清单和组件测试。

### F6（持久化 P2）迁移版本号与迁移内容不是一一对应

**证据**

- `server/db.ts` 的 `MIGRATIONS` 中，`from: 1` 到 `7` 的多个步骤重复 `db.exec(RUN_SCHEMA)`，`from: 10`、`11`、`15` 重复 `db.exec(ORGANIZATION_SCHEMA)`；schema 文本本身是当前版本的 idempotent DDL。
- 这意味着版本号只代表“执行到当前 schema”，而不是一份不可变的历史迁移脚本；以后修改 `ORGANIZATION_SCHEMA` 会改变旧版本库的重放结果。

**影响**

- 对旧库升级、差异审计和回滚验证的可解释性弱；一旦 schema 文本与历史步骤漂移，很难从代码直接知道某个版本实际创建了什么。
- 当前有旧库迁移测试和备份保护，所以不是立即故障，但长期维护成本高。

**建议**

- 固定历史迁移脚本（每步只引用当时版本的 schema/DDL），不要复用当前全量 schema；新增结构变更时追加不可变 DDL 步骤。
- 为每个 schema 版本增加 checksum/迁移测试快照，确保升级路径可重放、可审计。

### F7（证据 P2）“AI 用户复盘/自进化”的真实模型验收弱于其他模块

**证据**

- `docs/RUNTIME-V2.md:240` 明确记录：2026-11-17 的 AI 用户复盘真实模型抽样 1/9 通过，8 个常规样本未形成有效复盘；本批未通过，且预算耗尽后未继续调用。
- 四批优化的固定九类真实模型证据是另一套任务场景；它不能替代“复盘质量”本身的真实模型验收。
- `ExperienceService` 使用完成任务的同一模型做自评，虽有 FactLedger、独立复核和人工校准，但自评偏差仍是已知风险。
- `core/evolve` 的提案触发仍以正则强调词、工具失败计数、bigram 相似度为主；人类采纳前不会自动改技能或代码，这是安全优点，但提案质量还没有独立评估。

**影响**

- “评价系统辅助自进化”这条产品主张，当前更多是流程正确，而不是已被真实模型证明持续产生高价值改进。
- 如果拿 1/9 的复盘验收去支撑路线决策，会重复同源评测的旧问题。

**建议**

- 用固定预算重跑“复盘质量”真实模型验收，明确通过标准（有效复盘率、建议可采纳率、人工校准一致率），不要只看调用次数。
- 对 AI 建议做人工抽样评估：多少建议真正进入问题池、多少修复后被回归验证、多少产生负面副作用。
- 自进化提案增加“提案质量”指标（被采纳后的回归通过率、重复率、误报率），再决定是否扩大自动触发。

## 四、建议的收敛路线

### P0：先冻结功能，统一边界（1 周）

1. 写一页架构决策：哪些能力是 host service，哪些是 plugin；AI 社会如何落位。
2. 增加 SDK 边界门禁：core/plugins 不能直接 import kernel 内部；server 不能直接 import core 内部。
3. 为 SocietyService/OrganizationService 注入 Clock，先修确定性测试和 E2E 等待方式。
4. 停止在 `society.ts` 继续加分支；先拆分 selection/scheduler/settlement/snapshot。

### P1：再重构核心复杂度（2-4 周）

1. 角色选择改为显式能力/任务 schema；关键词表仅作兼容层。
2. 六因子权重进入制度版本；关系分只由可核对事件产生；社会健康分给出公式/样本/置信度，或降级展示。
3. 单例化 `OrganizationService`，给 tick/snapshot 做性能基准和查询上限。
4. 增加 lint、coverage、复杂度预算、组件测试；把 `society.ts` 的类/函数数量作为重构目标。

### P2：再做产品语义决策

- 如果目标是“AI 劳动组织/社会运行层”：把名称、文档、UI 从“社会体验”收敛为“组织调度与治理”，避免过度承诺。
- 如果目标是“AI 原生社会体验”：需要单独设计社会模拟层——角色内部状态、偏好/记忆、角色间对话与协商、冲突/合作动力学、时间和事件模型；现在的 scheduler 不能靠增加字段变成社会模拟。
- 两条路线不要同时推进；否则会把当前的指标伪精确和复杂度问题放大。

## 五、审查证据索引

- 内核边界：`web-agent/kernel/tests/dependency-boundary.spec.ts`
- 插件 SDK：`web-agent/kernel/plugin-sdk.ts`；core 深引统计：69/115 个 core 源码文件
- 社会核心：`web-agent/server/society.ts`（2,531 行；权重 285；启发式 734-771；健康分 2125-2130）
- 组织存储/制度：`web-agent/server/organization-store.ts`（`InstitutionPolicies` 410-425）
- 体验复盘：`web-agent/server/experience.ts`（1,620 行；`now` 注入 686）
- 时间与测试：`web-agent/server/tests/society.spec.ts`；E2E `web-agent/ui/e2e/society-real-backend.spec.ts`
- 产品边界声明：`web-agent/docs/AI-ORGANIZATION.md:5`
- 真实模型复盘记录：`web-agent/docs/RUNTIME-V2.md:240`
- 工程验证：`npm test` 1531 总用例/1529 通过/2 跳过；`npm run test:security` 402/402；`selftest` 90/90；`eval:ci` 28/28；`eval:optimization` 108/108；E2E 133/133；`npm audit --omit=dev` 前后端 0 漏洞；CI `quality` + `e2e` 双绿。

---

**结论**

maharness 的底座是可靠的，测试和安全投入值得保留；真正需要修的不是再多做几个功能，而是把已经长进 server 的产品能力重新收进明确边界，把“社会”从口号变成可解释、可验证、可收敛的模型。先做架构收敛和语义校准，再谈扩展，项目会稳得多。

## 六、修复进度（2026-11-19）

| 项 | 状态 | 落地内容 |
| --- | --- | --- |
| F2 插件 SDK 边界 | 已完成 | core/plugins 源码统一从 `kernel/plugin-sdk` 导入；新增依赖边界测试与 `check:boundaries`。 |
| F4 时钟 | 已完成 | `OrganizationService` / `SocietyService` 注入 `now`，业务路径不再直接 `Date.now()`；新增确定性测试。 |
| F3 角色权重 / 任务提示 | 部分完成 | 六因子权重进入 `InstitutionPolicies` 并版本化；任务支持 `requiredCapabilities` / `needsWrite`；旧关键词推断保留兼容。 |
| F3 社会健康指标 | 部分完成 | 健康快照增加 `scoreKind: weighted_heuristic`、`sampleSize` 和显式权重；UI 标注“启发式”。 |
| F5 文件拆分 | 部分完成 | 制度默认值与校验拆到 `server/society/policy.ts`，角色选择评分拆到 `server/society/selection.ts`，社会健康拆到 `server/society/health.ts`，单体入口归入 `server/society/index.ts`；热点路径复用单个 `OrganizationService`；调度/结算/快照仍需继续拆分。 |
| F6 迁移 | 部分完成 | 增加迁移版本连续性门禁；历史 schema 快照/不可变 DDL 尚未重构。 |
| F7 体验真实模型证据 | 未完成 | 需要单独重跑并预算；本次只补了工程门禁与文档。 |
| F1 host service 边界 | 部分完成 | 已明确 host service / plugin 的边界语义；`server/host-services.ts` 统一装配宿主服务，减少 routes 直接构造服务；全量插件化仍需后续架构批次。