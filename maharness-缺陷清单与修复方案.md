# maharness 缺陷清单与修复方案

> **审查对象**：`D:\DEEPSEEK\maharness\web-agent`（maharness v0.1.0）
> **基线 commit**：`1540590`（`maharness` 分支，2026-09-11「时空可组合性四缺口补齐 + v3.3 内核修缮入库」）
> **本文日期**：2026-10-13（基于该基线的静态审查；行号以提交 `1540590` 为准）
> **前序文档**：[maharness-审查报告.md](maharness-审查报告.md)（2026-08-17，对照 Cordis 的机制审查）——本文是其**后续**：那份报告看的是"机制设计对不对"，本文看的是"实现与承诺是否一致、边界是否真的封住了"。
> **方法**：全量源码精读（kernel 20 文件 / core 16 插件 / server 全路由 / ui 全组件 / docs 8 篇）+ 运行时归档数据统计（`data/traces/*.jsonl`）+ 实测（`npm run typecheck`、`npm test`）+ 逐条**证伪式核查**（每条怀疑都要求"读到确凿代码才判成立"，读不到证据即驳回）。
> **不覆盖**：未做动态渗透测试、未在真实 provider 上跑端到端、未评审第三方依赖自身的漏洞、未评审 ARS 技能包内容（上游零修改，另行跟踪）。

---

## 0. 结论摘要

### 0.1 统计

| 等级 | 条目数 | 说明 |
|---|---|---|
| **P0** | **5** | 破坏已文档化的安全承诺（A1/A2），或破坏核心机制正确性（B1/C1） |
| **P1** | **16** | 可绕过防护/功能必然失败/用户可感知的行为错误 |
| **P2** | **24** | 静默失效、口径漂移、资源缓增、文档失真 |
| **P3/记录** | **4** | 机制真但影响可忽略，建议只记录 |
| 已证伪 | 5 | 见 §3「误报澄清」——列为独立章节，防止未来重复排查 |

合计 47 条（含修复过程中新发现的 B13/B14——两者都是运行时快照机制的连带后果，静态审查未预见，由 `selftest` 失败 + `git stash` 基线对照暴露）。

按类别：安全与审批 10、正确性与功能 14、可观测性 4、资源与性能 2、一致性与文档 10、前端与测试 5、记录类 4。

### 0.2 三条最重要的判断

1. **"审批不可绕过"与"内核保护区"这两条 README 级承诺，当前都能被绕过**（A1、A2）。A1 是判定算法问题（PowerShell 只读白名单只看每段首 token，脚本块内容完全不参与判定）；A2 是保护名单的**基座错位**问题——名单按 `sandboxRoot` 算相对路径，而敏感资产（`.env`、`data/secret.key`、`data/agent.db`）位于项目根，当前部署 `SANDBOX_ROOT=D:\DEEPSEEK` 而项目根是 `D:\DEEPSEEK\maharness\web-agent`，于是"项目 data/ 不可读"这条保护**实际不生效**。这两条不是"配置没调好"，是边界设计缺陷。

2. **内核自身的可观测性被内核自己的埋点破坏了**（C1）。`service_call` 步骤占归档的 **96.3%~99.5%**（实测 `2026-09-10.jsonl` 1423 行中 1371 行、`2026-09-29.jsonl` 406 行中 404 行），1000 容量的 ring 被约 1.5 条/秒的簿记灌满（约 11 分钟一轮），真实对话步骤被挤出 → 轨迹面板查不到 → 回退到整文件同步读归档。根因是 `kernel.cache/trace/budget` 是"解析视图"getter，每次属性访问都写一条 `service_call`；而 ARCHITECTURE §1.5.2b 明确承诺"无接管 = 零额外开销"。**这是"注释承诺与实现不符"的典型，也是当前唯一会随时间自伤的问题。**

3. **测试护栏已经很厚，但覆盖方向偏后端机制**。实测 `npm test` **362 通过 / 74 套件 / 0 失败**，`typecheck` **0 error**（审查报告时代的"零测试"已彻底解决）。但前端 E2E 只有 1 个 spec / 9 个 test（全部落在气泡菜单·引用·表情），而 ARCHITECTURE §8 声称的"断点续跑 / 子代理 3 层下钻 / handoff 横幅"**零自动化覆盖**；`ui/` 下另有 20 个 `diagnose-*.mjs` 诊断脚本容易被误当作 E2E 证据（其自注"非 e2e 断言"）。

### 0.3 修复批次总览

| 批次 | 主题 | 含条目 | 可否并行 |
|---|---|---|---|
| **Batch 1** | 可观测性护栏 + 核心正确性 | C1 C4 B1 B7 B11 B12 | 4 个互不重叠的写者，可并行 |
| **Batch 2** | 安全收口 | A1 A2 A3 A4 A5 A6 A7 A8 A9 B10 | 6 个写者；**A2 与 B10 同文件（sandbox.ts），须串行或同一写者** |
| **Batch 3** | 功能与资源 | B2 B3 B4 B5 B6 B8 B9 D1 D2 | 4 个写者；**B3/B4/B8 同文件（plugin-loader.ts），须串行** |
| **Batch 4** | 一致性与前端 | E1~E10 F1~F5 | 可并行（ui/ 与 docs/ 分离） |
| **Batch 5** | 文档与"已知边界"收口 | E2 依赖 Batch 2 结论 | 最后做 |

Batch 1 与 Batch 2 写范围不重叠，建议**同时启动**（P0 安全项不应等可观测性）。

---

## 1. 缺陷总表

> 证据等级：**已复现** = 用运行时数据或实测命令验证；**代码确认** = 逐行读到判定链完整；**静态确认** = 读到实现但未构造触发场景；**潜在** = 触发条件当前不满足（配置未启用等）。

| ID | 等级 | 类别 | 标题 | 位置 | 证据 | 批次 |
|---|---|---|---|---|---|---|
| A1 | **P0** | 安全 | PowerShell 只读白名单可被脚本块绕过 → 免审批任意 .NET 执行 | `core/powershell/index.ts:60-132` | 代码确认 | 2 |
| A2 | **P0** | 安全 | 保护名单基座错位：项目 `.env`/`data/**` 可读可写，写类工具默认免审批 | `kernel/sandbox.ts:52-68`、`core/tools-fs/index.ts:135,358,403`、`server/routes/files.ts:63-90` | 代码确认 | 2 |
| A3 | P1 | 安全 | `web_fetch` 的 IPv4-mapped IPv6 十六进制形式绕过私网判定（SSRF） | `core/search/index.ts:70-89` | 代码确认 | 2 |
| A4 | P1 | 安全 | MCP：透传全量 env、默认免审批、不回收孙进程、协议版本不一致、HTTP 传输无 URL 校验 | `core/mcp/index.ts:89-93,102,176,185-198,194,214,256,270` | 代码确认 | 2 |
| A5 | P2 | 安全 | providers 校验重定向不逐跳复检（可读型 SSRF）+ 私网段不全 + `AGENT_ALLOW_PRIVATE_URLS` 语义不一致 | `server/routes/shared.ts:117-157`、`providers.ts:44,178-196,189,227-233` | 代码确认 | 2 |
| A6 | P2 | 安全 | HTTP 层无鉴权：可代批准审批、可把沙箱根切到盘符根、可注入 allow 策略 | `server/index.ts:88-98`、`routes/approvals.ts:37-45`、`routes/workspaces.ts:19-47`、`routes/rules.ts:101-108` | 代码确认 | 2 |
| A7 | P2 | 安全 | `secret.key` 权限在 Windows 无效；解密失败静默空串；密钥文件可被覆盖 | `server/secrets.ts:16-37`、`server/db.ts:194-202` | 代码确认 | 2 |
| A8 | P2 | 安全 | `delete_file` 与 `powershell_execute` 防御深度不对称（policy allow 对后者直接生效） | `core/tools-fs/index.ts:448,463` vs `core/powershell/index.ts:232-237` | 代码确认 | 2 |
| A9 | P2 | 安全 | 技能同步只校验 `SKILL.md`，整目录无校验落盘 | `kernel/skillsSync.ts:125-133` | 代码确认 | 2 |
| A10 | P2 | 可用性 | PowerShell 黑名单误拦（`2>$null` 等），trace 中有实证 | `core/powershell/index.ts:44-57` | 已复现 | 2 |
| B1 | **P0** | 正确性 | run 内压缩吞掉 L0 system prompt（注释与代码相反） | `core/chat/compact.ts:57,71,94` + `core/chat/agent.ts:208,334` | **已复现** | 1 |
| B2 | P1 | 正确性 | 委派配额先扣后校验；`run_parallel` 4 任务必然失败并白烧 3 次配额 | `kernel/budget.ts:69-83`、`core/subagent/index.ts:146,264`、`core/parallel/index.ts:21,112-121` | 代码确认 | 3 |
| B3 | P1 | 正确性 | reload 回滚分支把 error 态实例提交进注册表并返回成功 | `kernel/plugin-loader.ts:1047-1062` | 代码确认 | 3 |
| B4 | P2 | 正确性 | `watchConfig` 依赖签名失效：对象值恒 `[object Object]`、通配键恒 `undefined`、读全局 config | `kernel/plugin-loader.ts:586-596` | 代码确认 | 3 |
| B5 | P2 | 正确性 | L1 embedding 分支跳过"动作方向校验"（当前未激活） | `kernel/cache.ts:383-404` | 潜在 | 3 |
| B6 | P2 | 正确性 | `validate.ts` 未知 type fail-open 且无告警 | `kernel/validate.ts:65-76` | 代码确认 | 3 |
| B7 | P1 | 正确性 | `waterfall` 无监听器错误隔离 → 钩子抛错掀翻整轮对话 | `kernel/bus.ts:156-187` + `core/chat/agent.ts:181-185` | 代码确认 | 1 |
| B8 | P2 | 正确性 | `plugin.json` 的 `enabled/lazy` 反向翻转有一拍延迟 | `kernel/plugin-loader.ts:1347` | 代码确认 | 3 |
| B9 | P2 | 正确性 | `l1Get` 的 embedding 调用无错误隔离；维度不一致时静默永不命中 | `kernel/cache.ts:384,540-549` | 代码确认 | 3 |
| B10 | P2 | 正确性 | `allowCoreEditCache` 进程内固化；沙箱根不存在时归因错误 | `kernel/sandbox.ts:20-36,49-54` | 代码确认 | 2 |
| B11 | P2 | 正确性 | `bail` 真值短路对 async 监听器返回未决 Promise（无生产调用者） | `kernel/bus.ts:119-132` | 代码确认 | 1 |
| B12 | P1 | 功能 | 配置热更新不落盘：`/api/config` 的改动重启即丢 | `kernel/config.ts:41-51`、`server/routes/config.ts:46-75` | **已复现** | 1 |
| B13 | P1 | 正确性 | 快照副本与活目录是两个模块实例 → 模块级单例状态分裂（写一份读另一份） | `core/chat/result-store.ts:77`、`core/chat/provider-health.ts:51` | **已复现**（selftest + stash 对照） | 1 |
| B14 | P1 | 工程 | 测试 glob 把运行时快照当源码测；脏快照无回收 → 用例数与结果随磁盘残留漂移 | `package.json` test 脚本、`kernel/plugin-loader.ts:register`、`plugin-snapshot.ts:SKIP_DIR` | **已复现** | 1 |
| B15 | P1 | 功能 | `withTimeout` 竞速定时器从不 `clearTimeout` → 每次插件生命周期留一个 30s ref'd 定时器，进程跑完也不退出 | `kernel/plugin-loader.ts:57-65` | **已复现**（`getActiveResourcesInfo` 见 32 个 Timeout） | 1 |
| B16 | P1 | 功能 | `startServer` 导出的 `closeEnvWatcher` 从未被 selftest 调用 → `.env` 目录 `fs.watch` 句柄一直 ref 事件循环 | `scripts/selftest.ts:674-679`、`server/index.ts:166` | **已复现** | 1 |
| B17 | P1 | 正确性 | 插件侧 `ctx.cache`/`ctx.trace` 直接拿内核内置实例，**绕过服务仲裁**——接管后 `kernel.*` 换了、插件自己用的还是旧实现 | `kernel/plugin-loader.ts` buildContext（原 `trace/cache: this.ctxBase.*`） | **已复现**（已修 + 回归） | 2 |
| C1 | **P0** | 可观测 | `service_call` 噪声占归档 96~99.5%，挤掉真实步骤 | `kernel/plugin-loader.ts:813-828`、`kernel/index.ts:107-116` | **已复现** | 1 |
| C2 | P2 | 可观测 | 归档回退是整文件同步读；归档无轮转/清理；`flushTimer` 未 unref | `kernel/trace.ts:55-56,96-101,147-157` | 代码确认 | 1 |
| C3 | P2 | 可观测 | 统计口径不自洽（overall 只用 L1；"本周节省"实为累计；轨迹面板分母混入工具调用） | `server/routes/stats.ts:17,76-92`、`ui/src/components/TracePanel.tsx:141-142` | 代码确认 | 4 |
| C4 | P2 | 可观测 | 注释声称的 `factVersion` 快速路径在实现中不存在 | `kernel/plugin-loader.ts:1091-1117` | 代码确认 | 1 |
| D1 | P2 | 资源 | `Budget.sessionCalls` 键永不删除（约 200~400 B/会话，非失控泄漏） | `kernel/budget.ts:69-83` | 代码确认 | 3 |
| D2 | P2 | 资源 | 价格正则让 mini/haiku 套大模型单价；`pricesFor` 定义未用 → 路由后计价与实调模型脱钩 | `kernel/modelCatalog.ts:27,35,61-63`、`core/chat/provider.ts:140-144` | 代码确认 | 3 |
| E1 | P1 | 一致性 | L1 阈值：代码 0.58（3 处）vs 前端 0.85（2 处），0.85 是被实测否决的值 | `ui/src/components/SettingsView.tsx:347`、`ui/src/components/StatsView.tsx:114` | 代码确认 | 4 |
| E2 | P1 | 文档 | README「安全模型」与实现不符（审批可绕、`.env` 可写） | `web-agent/README.md:60-66` | 代码确认 | 5 |
| E3 | P2 | 文档 | README 称 `context.maxTokens` 默认 30000，代码为 60000（5 处） | `web-agent/README.md:42` vs `core/chat/agent.ts:330` 等 | **已复现** | 4 |
| E4 | P2 | 文档 | 内核件数 5/6/7 三值漂移，且"6"在两处指不同集合 | `docs/ARCHITECTURE.md:59,77,337,354,688,708`、`kernel/index.ts:3` | 代码确认 | 4 |
| E5 | P2 | 文档 | SQL 表文档列 4 张、实际 8 张；`cache_entries` 虚指；`plugin_state` 为死表 | `docs/ARCHITECTURE.md:608-616` vs `server/db.ts:96-137` | 代码确认 | 4 |
| E6 | P2 | 文档 | API 表文档 19 条、实际注册 70 条，整类缺失 9 类 | `docs/ARCHITECTURE.md:622-645` vs `server/routes/` | 代码确认 | 4 |
| E7 | P2 | 文档 | §8 点名的组件多数已不存在或已改名 | `docs/ARCHITECTURE.md:656` | 代码确认 | 4 |
| E8 | P2 | 文档/测试 | §8 声称的 3 项 E2E 无对应 spec；诊断脚本与 E2E 职责混淆 | `docs/ARCHITECTURE.md:675-677`、`ui/diagnose-*.mjs` | 代码确认 | 4 |
| E9 | P3 | 文档 | 让用户配 `config.json`，但仓库无该文件也无 `config.example.json` | `web-agent/README.md:124,127` | 代码确认 | 4 |
| E10 | P3 | 文档 | `agent.stopped` 注释残留；版本号存在第 4 处字面量；`ui/package.json` version 无人读取 | `kernel/loop.ts:39`、`ui/src/components/Sidebar.tsx:274` | 代码确认 | 4 |
| F1 | P2 | 前端 | 6 个组件零 import（死代码） | `ui/src/components/{FileTree,PluginPanel,SkillsPanel,StatsPanel,PersonaPanel,SessionList}.tsx` | 代码确认 | 4 |
| F2 | P1 | 前端 | 假柱状图 + 3 条静态假进度条 + `¥`/`$` 双口径 | `ui/src/components/StatsView.tsx:9,78,82,113,123,136`、`SettingsView.tsx:290` | 代码确认 | 4 |
| F3 | P2 | 前端 | `App.tsx` 单点复杂度（1074 行 / 26 state）；15 处 useCallback 依赖含 toast | `ui/src/App.tsx` | 代码确认 | 4 |
| F4 | P2 | 前端 | 轨迹面板上限 200 条会淘汰父步骤；缓存率回退口径被工具调用污染 | `ui/src/App.tsx:220`、`TracePanel.tsx:141-142` | 代码确认 | 4 |
| F5 | P2 | 一致性 | `core/` 插件不受文件监听，"保存即生效"只对 `plugins/` 成立 | `kernel/plugin-loader.ts:1303-1306` | 代码确认 | 4 |
| R1 | P3 | 记录 | `Budget` 数组上限 ≤3/键（影响可忽略） | `kernel/budget.ts:75-77` | 代码确认 | — |
| R2 | P3 | 记录 | `SOURCE_EXT` 不含 `plugin.json` 不导致改动丢失（见 §3 G1） | `kernel/plugin-snapshot.ts:16` | 代码确认 | — |
| R3 | P3 | 记录 | 权重：`enable()` 对熔断插件不会静默成功（真问题在 B3） | `kernel/plugin-loader.ts:1240-1251` | 代码确认 | — |
| R4 | P3 | 记录 | trace 归档单文件当前 0.01~0.92 MB，`queryArchive` 最坏数 MB 同步读 | `data/traces/` | 已复现 | — |

---

## 2. 详细条目

### A. 安全与审批

#### A1 [P0] PowerShell 只读白名单可被脚本块绕过，免审批执行任意 .NET 代码

- **现象**：`powershell_execute` 声明 `approval: true`，但 `assessApproval` 会在判定为"只读"时直接放行。判定只看**每段命令的第一个空白分词**是否在白名单，段内其余内容（包括脚本块 `{...}`、静态成员调用 `::`）完全不参与判定；危险词黑名单是对整条命令做正则扫描，词表里没有任何"脚本块/成员调用"构造。
- **证据**（判定链完整）：
  - `core/powershell/index.ts:68-70` 按 `| ; && || 换行` 拆段；`:60-65,101-104` 每段只取第 0 个 token；`where-object`/`select-object` 在只读白名单里（`:14-19`）。
  - `:124-132` 三道判定：`needsApproval: !readOnly || !!hit || !!sensitive`。
  - `core/chat/agent.ts:133-146` `assessApproval` 存在时**覆盖** `approval: true` 声明。
- **可直接免审批执行的 payload（已按判定链逐步核对）**：
  1. `Get-ChildItem | Where-Object { [System.IO.File]::WriteAllText('D:\DEEPSEEK\pwn.txt','x') }`
  2. `Get-ChildItem | Where-Object { [System.Diagnostics.Process]::Start('cmd.exe','/c calc.exe') }`
  3. `Get-ChildItem | Select-Object @{n='x';e={[System.IO.File]::Delete('D:\DEEPSEEK\x')}}`
  4. `Get-ChildItem | Where-Object { [IO.File]::Delete('x') }`
  四个 payload 的每段首 token 均在白名单；黑名单（`Remove-Item`/`Set-Content`/`>`/`Invoke-Expression`/`npx`）与敏感词（`.env`/`agent.db`/`secret.key`）全不命中 → `needsApproval=false`，直接执行。
- **触发条件**：一次普通工具调用。无需前置条件（cwd 锚定沙箱根不构成阻碍，payload 用绝对路径即可）。
- **影响**：**能绕过审批**，是执行者权限下的任意 .NET 代码执行（任意读写/起进程/发网络）。这不是"标签不准"。可达路径不是纯理论：`web_search`/`web_fetch` 的外部内容会进入模型上下文，提示注入可引导模型产出此类命令。
- **根因**：判定模型是"段首词 ∈ 白名单 ⇒ 只读"，而 PowerShell 的参数表达式本身就是代码；把命令降维成一个 token 必然漏放。
- **修复方案**（推荐）：
  1. `:60-76`（token 提取）改为**结构分类**：对每段提取"是否含脚本块 `{}` / 子表达式 `$()` / 成员调用 `::` / 调用运算符 `&` `.` / 反引号 / 变量赋值"等构造信号，供判定层使用；
  2. `:101-110`（`segmentIsReadOnly`）改为"白名单 cmdlet **且** 其参数落在安全子集（字面量开关、普通路径/字符串、比较与筛选运算符）"才算只读；出现构造信号即视为非只读；
  3. `:44-57` 危险词表从"枚举危险词"改为"枚举危险构造"，并**按段**应用而非只扫整串；
  4. 保留现有 fail-closed 兜底（`agent.ts:139-141` 判定抛异常按需审批）作为安全网。
- **备选**：把 `powershell_execute` 改为默认需审批、仅对"白名单 cmdlet + 无构造信号"的窄集合免审批（同上，但白名单更窄）。
- **验收**（新增 `core/powershell/tests/assess-approval.spec.ts`）：上述 4 个 payload + 至少 6 个自造变体断言 `needsApproval === true`；同时断言 10 条正常只读命令（`Get-ChildItem`、`Get-Content x | Select-String y`、`git status` 等）仍 `false`。
- **工作量**：0.5~1 天（判定重构 + 用例表）。**风险**：白名单收紧会产生误拦，必须与 A10 一起做（否则可用性下降）。

#### A2 [P0] 保护名单基座错位：项目 `.env`/`data/**` 可读可写，写类工具默认免审批

- **现象**：两条独立缺陷叠加成提权链：
  1. **写侧无敏感名单**：`isProtectedWritePath` 只管 `kernel/`、`core/chat/`；`.env` 与 `data/` 只出现在**读**黑名单里，写侧没有对应物。
  2. **读写名单都按 `sandboxRoot` 算相对路径，而敏感资产在项目根**：当前部署 `SANDBOX_ROOT=D:\DEEPSEEK`（`.env` 中已设置；启动日志："沙箱根目录: D:\DEEPSEEK"），项目根是 `D:\DEEPSEEK\maharness\web-agent`（启动日志："[env] 监听 D:\DEEPSEEK\maharness\web-agent"）。
- **证据**：
  - `kernel/sandbox.ts:52-58` 写保护仅 `kernel/`、`core/chat/`；`:63-68` 读名单为 `norm === '.env' || norm.endsWith('/.env')` / `norm === 'data' || norm.startsWith('data/')`。
  - `core/tools-fs/index.ts:135` `writeNeedsApproval = () => ctx.config.get('tools.writeRequiresApproval', false)` → **默认 false**；`:358`/`:403` 用它做 `assessApproval`。
  - `server/routes/files.ts:63-90` 写接口同样只查 `isProtectedWritePath`，**无审批概念、无 .env/data 规则**。
  - `server/index.ts:166-191` 监听项目 `.env` → `dotenv.config({ override: true })`；`core/search/index.ts:83`、`server/routes/providers.ts:106,130,227` **每次调用时读 env**。
- **可达路径（当前配置下）**：权限计算基于 `SANDBOX_ROOT`，但保护名单不匹配长路径 → `write_file('maharness/web-agent/.env', ...)`、`read_file('maharness/web-agent/data/secret.key')`、`write_file('maharness/web-agent/data/rules.json', ...)` 全部**不被拦截**：
  - 写项目 `.env` 追加 `AGENT_ALLOW_PRIVATE_URLS=1` → 热重载 → SSRF 防护即时失效（无需重启）；
  - 写项目 `data/rules.json` 注入 `{tool:"*",effect:"allow"}` → `core/rules/index.ts:92` 置 `policyApproved` → `core/chat/agent.ts:742-747` 跳过审批门 → 危险 PowerShell 免审批执行（F1/A1 叠加）；
  - **读**项目 `data/secret.key`（AES 主密钥）+ `data/agent.db`（含全部 API Key 密文）→ 离线解密（A7 叠加）。`.env` 因 `endsWith('/.env')` 仍被读侧挡住，但 `data/**` 没有任何一层兜住。
- **触发条件**：`SANDBOX_ROOT ≠ 项目根`（当前部署即如此）时，**全部** `data/**` 保护失效；`SANDBOX_ROOT = 项目根`（未设时的默认）时，`write_file('.env')` / `data/rules.json` 直接命中。
- **影响**：**审批与密钥保护同时失效**，且存在从"一次免审批文件写"到"关闭 SSRF + 审批旁路 + 密钥外泄"的完整链条。
- **根因**：敏感清单是"沙箱相对路径"语义，而它要保护的资产是"项目相对路径"语义；两个基座在 `SANDBOX_ROOT` 被显式设置时分离，且只有读侧有名单、写侧没有。
- **修复方案**（推荐，两层同时做）：
  1. **名单改为双基座匹配**：新增 `isSensitivePath(abs, { sandboxRoot, projectRoot })`，同时按两个基座计算规范相对路径，任一命中即视为敏感；`.env` 规则保留 `endsWith('/.env')` 语义，`data/` 规则改为"项目根下的 `data/**`"而非"沙箱根下的 `data/**`"。读侧同步替换，写侧新增同名判定。
  2. **写侧补门**：`write_file`/`edit_file`/`delete_file` 的 `assessApproval` 对敏感路径返回 `needsApproval: true`（理由写明"敏感路径"）；`server/routes/files.ts` 的写接口对敏感路径直接 403（HTTP 路径没有审批语义，只能拒绝）。
  3. **配置收紧**：`tools.writeRequiresApproval` 默认值是否保持 `false` 属产品决策——建议保留，但敏感路径**始终**需审批（不受该开关影响）。
- **备选**：把 `data/` 全部迁出沙箱可见范围（例如 `SANDBOX_ROOT` 强制不等于项目根，并在项目根下建立不受沙箱管辖的数据目录）。改动面更大，但把"基座错位"从根上消除。
- **验收**（扩展 `kernel/tests/*` 与 `core/tools-fs` 测试）：
  - `read_file('maharness/web-agent/data/secret.key')` → 拒绝；`read_file('maharness/web-agent/data/agent.db')` → 拒绝；
  - `write_file('maharness/web-agent/.env', ...)` → 需审批（Agent 路径）/ 403（HTTP 路径）；
  - 正常读写工作区文件不受影响（回归现有 selftest `[tools]`/`[sandbox]` 段）。
- **工作量**：1 天（含两个入口 + 测试）。**风险**：`data/` 里也有插件自己写的合法数据（`todo.json`、`memory.json` 等），但要区分**插件经 `ctx.storage`/内核 API 写**（不走沙箱判定，不受影响）与 **Agent 经 `write_file` 写**（应被拦）——修改前需确认没有插件依赖"Agent 直接写 data/"这一路径。

#### A3 [P1] `web_fetch` 的 IPv4-mapped IPv6 十六进制形式绕过私网判定

- **证据**：`core/search/index.ts:70-76` 的 `isPrivateAddress` 对 `::ffff:` 前缀递归 `slice(7)`，但 WHATWG URL 会把 `[::ffff:127.0.0.1]` 规范化为 `[::ffff:7f00:1]`，`slice(7)` 得到 `7f00:1`，`isIP()===0` → 落到最后一行 → **返回 false（视为公网）**。
- **可达 payload**：`web_fetch { url: 'http://[::ffff:7f00:1]:3000/api/health' }`（等价连 `127.0.0.1`）；同族：`[::ffff:a00:1]`(10.0.0.1)、`[::ffff:c0a8:1]`(192.168.0.1)、`[::ffff:a9fe:a9fe]`(169.254.169.254)。
- **附带**：`PRIVATE_V4` 漏 `100.64.0.0/10`（CGNAT/Tailscale）、`198.18.0.0/15`、`240.0.0.0/4`、`224.0.0.0/4`；`isPrivateAddress` 的 IPv6 分支只覆盖 `fe80` 前缀（`fe80::/10` 实际含 `fe80–febf`）；体积上限在 `arrayBuffer()` **之后**才判（无 `content-length` 时可先吃满内存）。
- **修复方案**：① 用十六进制分组解析还原 IPv4-mapped 地址（或直接调用 `net.isIPv4` 前先做映射归一）；② 补齐私网段与 NAT64/6to4 嵌入检查；③ `fetchDoc` 改为流式累积并在超限时 `abort()`。
- **验收**：新增 `core/search/tests/ssrf.spec.ts`，表驱动断言上述 URL 全部抛错，正常公网 URL 通过。

#### A4 [P1] MCP 客户端的四个问题

| 子项 | 证据 | 影响 |
|---|---|---|
| stdio 透传全量 env | `core/mcp/index.ts:89-93` `env: { ...process.env, ...(this.cfg.env ?? {}) }` | 任何 MCP server（含 `npx -y <外部包>`）拿到全部 API Key |
| 默认免审批、`risk` 恒 medium | `:256` `risk:'medium'`、`:270` `if (cfg.approval) base.approval = true` | 第三方工具默认无审批门；`kernel/` 内无"按 risk 自动挂起"的机制（唯一门是 `approval`/`assessApproval`） |
| `close()` 只杀直接子进程 | `:173-177` `this.proc?.kill()` | Windows 上 `npx` 拉起的 node 孙进程不回收（对比 `core/powershell/index.ts:161` 用 `taskkill /PID /T /F` 杀树） |
| 协议版本不一致 / HTTP 无 URL 校验 | stdio 声明 `2025-03-26`（`:102`）vs HTTP `2026-07-28`（`:194,214`）；`:185-198` 不校验 `cfg.url` | 协商行为不确定；HTTP 传输可直连内网（与 search/providers 两处防护不一致） |

- **修复方案**：env 改为白名单透传（默认只传 `PATH`/`SystemRoot` 等 + 显式 `cfg.env`），或至少新增 `inheritEnv` 需显式开启；MCP 工具默认 `approval: true`（或按 server 配置的工具白名单免审批）；`close()` 在 win32 走 `taskkill /T`；协议版本抽成单一常量（跟随最新规范）；HTTP 传输复用 `assertPublicHttpUrl` 同款校验。
- **验收**：新增 `core/mcp/tests/`（或扩展 selftest）：断言 spawn 的 env 不含 `*_API_KEY`；断言默认 `assessApproval` 为 true；断言 URL 校验拒绝私网。

#### A5 [P2] providers 校验：重定向不逐跳复检（可读型 SSRF）+ 私网段不全 + 豁免语义不一致

- **证据**：`server/routes/shared.ts:139-157` 的协议白名单 + "DNS 解析后所有记录均检查"**是实现正确的**（十进制/十六进制 IPv4 不算绕过：`new URL('http://2130706433/')` 会规范化为 `127.0.0.1` 并被拦）。
- **真实缺口**：① `providers.ts:189` 与 `:44` 的 `fetch` 未设 `redirect`，默认 `follow` → **重定向目标完全不校验**；`/api/providers/test` 是盲 SSRF（不回显 body），`/api/providers/models` 会**解析并回吐**目标响应体 → **可读型 SSRF / 内网信息外泄**。② 校验解析一次、fetch 再解析一次，无 IP 钉扎 → 重绑定 TOCTOU。③ 私网段缺 `100.64/10`、`198.18/15`、`240/4`、`224/4`、`192.0.0/24`、NAT64/6to4 嵌入。④ `/api/providers/test`（`:178-182`）**无条件**校验，不收 `AGENT_ALLOW_PRIVATE_URLS`，而保存/PATCH/models 三处有豁免 → 注释承诺的"本机 Ollama 可放行"在"验证密钥"这一步不成立。
- **修复方案**：改 `redirect: 'manual'` + 逐跳复用同一校验（与 search 一致）；用 undici dispatcher 的 `connect.lookup` 钉住已校验 IP；补齐网段；四处豁免统一。

#### A6 [P2] HTTP 层无鉴权（含三个具体旁路）

- **证据**：`server/index.ts:88-98` —— Host 精确白名单（防 DNS rebinding）有效，但 `if (origin !== undefined && !allowedOrigins.has(origin))` → **无 Origin 头即放行**（注释明确把"同机非浏览器工具"列为放行对象）；全 `server/` 无任何 token/会话校验。绑定 `127.0.0.1`（`:198`）挡住局域网。
- **具体旁路**：
  1. `POST /api/approvals/:id`（`routes/approvals.ts:37-45`）无鉴权、无会话绑定 → **代用户批准**任何挂起审批（含危险 PowerShell、删除文件），id 可用 `GET /api/approvals` 列出；
  2. `POST /api/workspaces`（`routes/workspaces.ts:19-26`）接受**任意已存在目录**且无根限制，随后 `switch`（`:33-47`）只要求"已登记" → 可把 `sandboxRoot` 切到 `C:\`，此后保护区按新根计算（`C:\Windows\x` → `windows/x`）不再命中 → `/api/files/write` 可写 `C:\` 下任意可写位置；
  3. `PUT /api/rules/policy`（`routes/rules.ts:101-108`）直接写 `data/rules.json` → 一条 `{tool:"*",effect:"allow"}` 即旁路执行器审批门。
- **定级说明**：门槛是"本机任意进程可发请求"，而本机进程本就能直接读写这些文件；真实增量是**把文件权限升级为"改变 agent 行为与审批语义"**。浏览器侧已由 Host+Origin 基本封堵。故 P2，但"代批准"与"切沙箱根"两条建议按 P1 对待。
- **修复方案**（择一，按成本排序）：
  1. **最小**：禁止把盘符根/家目录登记为工作区（拒绝 `path.dirname(p) === p` 与 `os.homedir()` 及其祖先）；`/api/approvals/:id` 要求携带挂起时下发的一次性 token（前端已从 SSE 拿到 `approvalId`，可同时下发 token）；
  2. **中等**：进程启动生成随机 `data/api-token`（0600），对**所有变更类**端点要求 `X-Maharness-Token`，由服务端渲染的页面注入到前端（`window.__MAHARNESS_TOKEN__`）；
  3. **完整**：改用 Unix socket / Windows named pipe 传输，彻底不暴露 TCP 端口。
- **验收**：`server/tests/` 新增用例：无 token 的变更请求 401；`workspaces` 拒绝文件系统根；`approvals` 无 token 拒绝。

#### A7 [P2] 密钥存储：Windows 权限位无效 + 解密失败静默空串

- **证据**：`server/secrets.ts:16-37` 写 `data/secret.key` 后 `chmodSync(path, 0o600)`（Windows 上 `chmod` 只切只读位，不设 DACL → **不构成权限收紧**，代码注释已自承"语义有限"）；`server/db.ts:194-202` 解密失败 `catch → return ''`（只 `console.warn`）。
- **影响**：密钥与它所保护的密文（`data/agent.db`）、以及**可被 Agent 读取的同一目录**（A2）同处一个权限域；解密失败时 UI 仍显示"已配置"、`enabled=1`，直到真实请求 401 才变红 → 表现为"莫名其妙的鉴权失败"而非"密钥丢失"。另 `loadOrCreateSecretKey` 在密钥文件丢失/异常时**直接重新生成**（仅 warn）→ 旧密文全部不可解。
- **修复方案**：Windows 上用 `icacls` 收 DACL（或改用 DPAPI 保护密钥）；解密失败时通过 API 明确暴露 `hasKey:false` 并在 UI 出横幅；已存在密文时**拒绝**重新生成密钥，改为启动失败并给出明确指引。
- **验收**：单测覆盖"密文损坏 → API 返回 hasKey:false 且不静默"；手工验证 `icacls` 生效。

#### A8 [P2] 高危工具的防御深度不对称

- **证据**：`delete_file` 在 handler 内**二次**校验 `tctx.approved`（`core/tools-fs/index.ts:448,463`），而 `powershell_execute` 不校验（仅在校验+已批准时写审计，`:232-237`）。于是任何绕过执行器审批门的路径（策略 allow、写 `data/rules.json`、HTTP 直接调用）对 PowerShell 直接生效，对删除无效。
- **修复方案**：统一在 handler 内做 defense-in-depth（高危工具一律"未走审批即拒绝"），或在 `kernel` 层提供统一的 `assertApproved(tctx)` 供工具调用。

#### A9 [P2] 技能同步的完整性校验只覆盖 `SKILL.md`

- **证据**：`kernel/skillsSync.ts:125-133` —— 只对 `SKILL.md` 校验 sha256（且 `force` 时跳过），随后 `copyTree(srcSkillDir, destDir)` 把同目录 `scripts/`、`references/`、`assets/` 等**无校验**落盘；`copyTree` 也不清理目标目录已有文件。
- **影响**：`data/skills/<name>/` 下可出现未经验证的任意文件，若技能指示执行脚本则构成执行面；"锁文件 = 版本锁"的承诺局部失效。
- **修复方案**：锁文件扩展为**逐文件哈希清单**（或至少对 `scripts/**` 强制校验）；`installSkill` 先在临时目录校验完整清单再原子替换目标目录（顺带解决残留）。

#### A10 [P2] PowerShell 黑名单误拦（同一处判定的另一面）

- **证据**：`core/powershell/index.ts:47` 的 `>{1,2}\s*\S` 会把 `2>$null` 判成重定向写文件。实测 trace 中有实例：`data/traces/2026-08-15.jsonl:1068` 的四段首 token 全在白名单的只读管道仍弹了审批。
- **影响**：可用性（用户被迫点批准），并稀释审批卡的可信度（"总在乱弹"→ 用户习惯性通过）。
- **修复方案**：重定向判定限定在"命令位置"（段首或 `|`/`;` 之后的独立 token），排除 `2>`/`*>` 这类流编号与字符串内的 `>`；与 A1 的重构一并做（同一处代码）。

---

### B. 正确性与功能

#### B1 [P0] run 内压缩吞掉 L0 system prompt

- **现象**：超预算触发循环内压缩后，本轮剩余请求的系统提示词被替换为【历史摘要】——身份、纪律、安全约束全部消失。LLM 路径下 `systemPrompt` 不作为独立参数发送（组装进 `history[0]`），所以它真的被摘要掉了。
- **证据（已复现）**：
  - `core/chat/agent.ts:208-209` `history = [{ role:'system', content: systemPrompt }, ...messages, ...]`；`:334` 把 `llmCtx.history`（含 index 0）整个交给 `compactFn`。
  - `core/chat/compact.ts:71` 无既有摘要时 `compressibleFrom = 0`；`:81` `compressible = history.slice(0, cut)`（含 index 0）；`:94` `prefix = summaryIdx > 0 ? history.slice(0, summaryIdx) : []`（`summaryIdx = -1` → **空**）；`:95-99` 输出 `[...prefix, { system: summary }, ...kept]` → **index 0 被丢弃**。
  - **最能说明是 bug 的是同一文件 `:57` 的注释**：「system 消息不参与压缩——它由 AgentRunner 组装，此处只处理对话轮」——注释与代码相反。
  - 触发阈值：`agent.ts:330` `context.maxTokens` 默认 **60000**（不是 README 说的 30000），所以长会话才会现形。
  - server 侧 run 前的压缩路径（`server/routes/chat.ts:192,239`）传的是 DB 历史（`buildHistory`，L0 不在其中——`agent.ts:252-257` 的 `syncedCount` 初始化为组装后的长度，所以 system prompt 从不入库）→ **该路径无此问题**。范围仅限 run 内压缩。
- **影响**：一旦命中，剩余轮次的模型失去全部系统级约束（身份、工具纪律、"观察先于断言"、安全规则），行为退化且**无任何告警**；同时 system prompt 的丢失使后续 L3 前缀完全断裂（成本上升）。
- **根因**：`compact.ts` 假设"进来的 history 不含 system"，而循环内调用把它打破了。
- **修复方案**（推荐）：
  ```ts
  // compact.ts：头部 system（非摘要锚点）不参与压缩，且必须被保留
  const headIsSystem = history[0]?.role === 'system'
    && !String(history[0].content ?? '').startsWith(SUMMARY_MARK);
  const compressibleFrom = summaryIdx >= 0 ? summaryIdx + 1 : (headIsSystem ? 1 : 0);
  // 输出前缀：摘要锚点之前（含头部 system）全部保留
  const prefixEnd = summaryIdx >= 0 ? summaryIdx : compressibleFrom;
  const prefix = history.slice(0, prefixEnd);
  ```
  注意原实现 `prefix` 取 `slice(0, summaryIdx)` 在无摘要时为空——**只改 `compressibleFrom` 不够，必须同时改 `prefixEnd`**，否则头部 system 会被"压出去"仍然丢失。
- **验收**（新增 `core/chat/tests/compact.spec.ts`）：
  - 构造 `[system(L0), ...20 条长消息]`，`maxTokens` 调到必然触发压缩 → 断言 `result.messages[0].role === 'system'` 且内容与原始 L0 **逐字节相同**；
  - 已有摘要锚点时：断言锚点前的头部 system 仍在，摘要只合并锚点之后的新段；
  - 断言压缩后总 token 下降（证明压缩真的发生，而不是"因为保留 system 就跳过压缩"）。

#### B2 [P1] 委派配额先扣后校验；`run_parallel` 4 任务必然失败

- **证据**：`kernel/budget.ts:69-83` 记账即最终（**无 release/refund API**），限额每会话 3 次/10 分钟（`:13`）、进程级 8 次（`:14`）；
  - `core/subagent/index.ts:146` 先 `consumeSubagentQuota`，`:152-153` 才校验 provider，`:163` 才校验 runner → provider/runner 不可用时**配额已扣**；`run_review` 同（`:264,268-275`）；
  - `core/parallel/index.ts:21` `MAX_PARALLEL = 4`，`:112-121` 逐个扣配额 → **任何 4 任务并行调用必然在第 4 次被拒**，同时白烧 3 次会话配额（正好占满 3/10min 窗口），返回错误、零子任务执行。
- **影响**：可观测的配额误耗 + 功能必然失败。模型见错后按提示"稍后重试"，会继续吃进程级池（8 次）→ 池满后用户真正需要的委派被阻塞。用户在 10 分钟窗口内"什么都委派不出去"。
- **修复方案**：
  1. **顺序修正**：所有委派工具先解析 provider/runner，再扣配额（失败路径不扣）；
  2. **引入 `releaseQuota(sessionId)`**（或在 `Budget` 里提供事务式 `withQuota(fn)`），异常路径归还；
  3. **语义对齐**：`run_parallel` 视为**一次委派**（扣 1 次），而不是每个子任务扣 1 次；
  4. 顺带把会话窗口上限与 `MAX_PARALLEL` 的关系写成不变量断言（`MAX_PARALLEL <= SUBAGENT_MAX_CALLS_PER_SESSION`）。
- **验收**：`kernel/tests/` + 新增 parallel 用例：4 任务并行 → 成功且只消耗 1 次会话配额；provider 不可用 → 配额不变。

#### B3 [P1] reload 回滚分支把 error 态实例提交进注册表并返回成功

- **证据**：提交分支有兜底 `if (fresh.state === 'error') throw`（`kernel/plugin-loader.ts:1036-1037`），**回滚分支没有**（`:1047-1062`）：回滚实例继承 `circuitBreaker`（`:1052`），`startInternal` 命中熔断分支（`:895-904` 裸 `return`，不抛）→ 注册表被写入 **error 态实例**，并发 `plugin.reloaded {rollback:true}`，`reload()` 正常 resolve；`reloadChanged` 还会把该 id 记入 `changed` 并写入新签名（`:1127-1129`）。
- **触发条件**：某插件连续失败 ≥3 次（阈值 3，冷却 60s）后，冷却期内发生 reload（文件改动热重载 / `reloadChanged` / UI 点重载）。
- **影响**："事务性热重载：坏版本自动回滚，永不半加载"的承诺在熔断叠加时被打破；API 返回 `ok:true` + `state:'error'`（`server/routes/plugins.ts:133-134`），管理面与调用方都被误导。
- **修复方案**：回滚分支补 `if (rollback.state === 'error') throw`（或让 `startInternal` 的熔断分支抛专用 `CircuitOpenError`，由调用方决定降级与上报）；`reload()` 的返回值改为携带 `state`，API 据此返回非 2xx。
- **验收**：`kernel/tests/loader.spec.ts` 新增：熔断态下 reload → 断言 reject（或 `ok:false` + `state:'error'`），且注册表中不出现 error 态实例。

#### B4 [P2] `watchConfig` 依赖签名失效

- **证据**：`kernel/plugin-loader.ts:586-596` 签名分量 `cfg:${key}@${String(loader.ctxBase.config.get(key))}`：
  - 对象值恒 `"[object Object]"` → 内部字段变化永不触发该插件重载（数组是例外：`String([1,2])='1,2'`）；
  - 通配键更极端：`ctx.watchConfig('rules.*')` → `config.get('rules.*')` 查字面 `rules` 下的 `"*"` 键 → 恒 `undefined` → 分量恒 `cfg:rules.*@undefined`（`core/rules/index.ts:80` 正是这种用法）；
  - 读的是**全局** `ctxBase.config`，而 `ctx.config.get` 走 override 链（`:650-656`）→ 语义不一致（方向是**多触发**：override 遮蔽时全局值变 → 无谓重载）。
- **影响**：声明了"配置依赖即自动重装"的插件可能永不因配置变化重载。in-tree 使用者（chat 的布尔标量、rules 的回调自处理）当前**无可见失效**，但契约是真实的缺口。
- **修复方案**：签名改用稳定序列化（`JSON.stringify` 键排序）；通配键展开为"该前缀下所有叶键的 `key=value` 列表"；改读 override 链后的有效值。

#### B5 [P2] L1 embedding 分支跳过"动作方向校验"（当前未激活）

- **证据**：`kernel/cache.ts:383-404` 的 embedding 路径只比 `promptKey` + `scope` + 余弦 ≥ `L1_THRESHOLD`（**硬编码 0.95，不可配置**），**完全不读 `entry.actions`**；而 Dice 分支（`:435-443`）有动作集合相等校验（正是为防"读文件A / 写文件A"互串而写）。
- **当前未激活**：`EMBEDDING_*` 在 `.env` 中是注释状态；`core/chat/provider.ts:356-360` 要求三项齐备才 `setEmbeddingFn`。
- **影响**（激活后）：L1 命中会**直接结束本轮、跳过 LLM 与工具调用**（`agent.ts:429-449`）→ "要写文件"被答成"文件内容是…"，动作不执行。
- **修复方案**：embedding 分支复用同一 `actions` 比对；或把 `actions` 并入缓存键。

#### B6 [P2] `validate.ts` 未知 type fail-open

- **证据**：`kernel/validate.ts:65-76` `default: return true` —— 不仅该层通过，`check()` 的分支判断（`:23-61`）也不匹配任何类型 → 该节点下的 `required`/`properties`/`enum`/`minLength`/`minimum` **一概不执行**，且**无告警、无 trace**。
- **影响**：两个入口都受影响（`manifest.config` 校验 → 插件配置校验恒过；工具 `outputSchema` → 回填校验恒过）；schema 可由 LLM 经 `create_plugin` 现场生成，错拼概率不低 → "成败机器可判"这一层静默失效。
- **修复方案**：未知 type 改为 fail-closed（返回 false + 明确报错信息），至少在 `check()` 入口对未知 type 写一条 warn/trace。

#### B7 [P1] `waterfall` 无监听器错误隔离 → 钩子抛错掀翻整轮对话

- **证据**：`kernel/bus.ts:105-132,156-187` —— `serial/bail/waterfall` 都是裸调用（任一监听器抛错即中断整链并向上抛），只有 `emit`/`emitAsync` 有 try/catch + `console.error`（`:72-80,229-234`）；`parallel` 是 `allSettled` 但最后仍抛 `AggregateError`。
- **关键**：`waterfall` 是**主对话路径**。`core/chat/agent.ts:181-185` 的 `emitHook` = `bus.waterfall(type, data, async () => {})`，被 `:272,:323,:628,:712,:846,:936` 直接 `await` 且无 try/catch；真实监听器有 memory（`before_llm`/`after_tool`，含落盘 I/O）与 rules（`before_tool`）。
- **影响**：任一插件钩子的同步抛错或 async reject → 异常穿出 `run()` 生成器 → **整轮对话失败**，而不是"跳过这个插件继续"。插件质量直接决定对话可用性，与"薄内核 + 可插拔"的隔离承诺相反。
- **修复方案**：给每种派发语义显式定义错误策略——推荐 `waterfall`/`serial` 默认**隔离并继续**（记录 warn + 入 trace，附带失败插件 id），新增 `strict` 选项供需要 fail-fast 的场景；`parallel` 保留 AggregateError（其语义本就是"等所有"）。
- **验收**：`kernel/tests/bus.spec.ts` 新增：抛错监听器不影响后续监听器执行与返回值；`emitHook` 层面加一条"监听器抛错但 run 继续"的用例（可用临时监听器在 `core/chat` 测试里注入）。
- **附带（同一 API 的语义陷阱）**：`waterfall` 把"监听器返回值非 undefined"视为短路接管（`:180`），若某监听器写成表达式体 `(e) => arr.push(x)`（返回数字）就会静默吞掉后续中间件。现有 in-tree 监听器全是块体，无此问题——建议加类型约束或文档警告。

#### B8 [P2] `plugin.json` 的 `enabled/lazy` 反向翻转有一拍延迟

- **证据**：`kernel/plugin-loader.ts:1347` 用**旧 manifest** 计算 `keepActive`；`enabled:false → true`（或 `lazy:true → false`）时以 `start=false` reload → 新实例停在 `loaded`，`loadAll` 只在启动时跑一次，也不会自行启动 → 直到该插件目录再变一次或手动 `enable`。
- **修复方案**：`onFileChange` 先读新 manifest 再判定 `keepActive`。

#### B9 [P2] `l1Get` 的 embedding 调用无错误隔离；维度不一致静默永不命中

- **证据**：`kernel/cache.ts:384` `await this.embeddingFn(norm)` 无 try/catch，调用点 `core/chat/agent.ts:428` 也不在 try 块内 → embedding HTTP 失败（401/30s 超时）会让异常穿出 `run()`、整轮对话失败；`kernel/cache.ts:540-549` 的 `cosine` 按查询向量长度索引被查向量 → 切换 embedding 模型导致维度不一致时得 `NaN` → `NaN >= 阈值` 恒 false → **静默永不命中**且无告警。
- **修复方案**：embedding 调用 try/catch（失败降级 Dice 分支并 warn 一次）；`cosine` 前校验维度一致，不一致则跳过该条并在 trace 里记一次。

#### B10 [P2] `sandbox.ts` 两处边界问题

- **证据**：
  - `:49-54` `allowCoreEditCache` 用"null 才读 env"的写法一次性固化，全文无重置入口（`scripts/selftest.ts:25` 的注释就是在绕它：必须在首次调用前 `delete process.env.AGENT_ALLOW_CORE_EDIT`）→ 运行期改 env 无效（与工具错误文案"设置后**重启**放行"一致，属已知取舍），但**测试隔离会互相污染**；
  - `:20-36` 向上查找最近存在的祖先时**不以沙箱根为界**：若 `sandboxRoot` 本身不存在（工作区目录被删、env 指错），第一个存在的祖先是根的父目录 → 抛"路径指向沙箱外（符号链接）"（**归因错误**），且**所有**文件工具与文件 API 都这样失败，连"在根下建新文件"也被拒。
- **修复方案**：导出 `resetProtectedWriteCache()` 供测试；向上查找以 `sandboxRoot` 为界，根不存在时明确报"沙箱根不存在，请重建或切换工作区"（而不是符号链接归因）。

#### B11 [P2] `bail` 对 async 监听器返回未决 Promise（无生产调用者，记录）

- **证据**：`kernel/bus.ts:119-132` 真值判定 → async 监听器返回的 Promise 恒为真值 → 立刻 `return` 该未决 Promise 并截断后续监听器。全仓 `.bail(` 只出现在 `plugin-loader.ts:488`（门面透传）与 `kernel/tests/bus.spec.ts:83`（同步监听器）。**当前无生产调用者**，故 P2。
- **修复方案**：`bail` 改为 async 并对返回值做 `await`（或在检测到 Promise 时明确拒绝 + 告警）；至少加一条测试把这个语义固化下来（现在是"未定义行为"）。

#### B12 [P1] 配置热更新不落盘（重启即丢）

- **证据（已复现）**：`server/routes/config.ts:46-75` 的 `PATCH /api/config` 只调 `kernel.config.set(...)`；`kernel/config.ts:41-51` 的 `set()` 只改内存 + 广播 `config.changed`，**不写盘**；全仓 `configFile` 仅在 `kernel/config.ts:19-26` 构造时被**读**（`grep configFile` 8 处无一处写）。项目根**不存在** `config.json`（只有 `tsconfig.json`），也无 `config.example.json`。
- **影响**：用户在设置页调的 `context.maxTokens`、`cache.l1Threshold/l2TtlMin/l3Enabled`、`agent.modelRouting`、思考预算等**全部在重启后回到默认值**，且 UI 不提示"未持久化"。warmup 的自动降级（C/D 相关）同样只活在进程内（这一点反而是好事，见 §7）。
- **根因**：`Config` 有两层（defaults ← config.json ← 运行时 set），只有读路径实现了，写路径缺失。
- **修复方案**：新增 `Config.persist()`（防抖 + tmp+rename 原子写，写 `paths.configFile`），**仅由显式用户路径调用**（`PATCH /api/config`、`PUT /api/rules/policy` 之类），运行期自动降级（如 warmup 置 off）走 `setRuntime()` 不落盘；补 `config.example.json`。
- **验收**：`kernel/tests/` 新增：`set + persist` → 新 `Config` 实例读同一文件 → 值保持；`setRuntime` 不产生文件；`PATCH /api/config` 后重启（模拟）值保持。

---

#### B13 [P1] 快照副本与活目录双实例：模块级单例状态分裂

- **发现过程**：Batch 1 后跑 `npm run selftest`，出现 1 项失败 `[result-store] recall_tool_result 零副作用重读`。用 `git stash` 做基线对照——**基线同样失败**，与 Batch 1 无关；再用最小复现脚本定位到根因。
- **机制**：`kernel/plugin-snapshot.ts` 把插件目录按内容镜像为 `core/<name>@<hash>/` 并从快照加载；而 `server/` 与 `scripts/` 仍 `import` 活目录 `core/<name>/…`。Node ESM 以完整 URL 为键 → **两个模块实例** → 各自持有一份模块顶层 `new Map()` / `new Store()`。
- **证据**：
  - `core/chat/result-store.ts:77` `export const resultStore = new ResultStore();`（活/快照各一份）；
  - `core/chat/provider-health.ts:51` `const health = new Map<string, ProviderHealth>();`；
  - `server/routes/providers.ts:7` 从**活目录** import `getProviderHealth/noteProviderFailure/noteProviderSuccess`；`core/chat/agent.ts:10` 从**快照副本** import 同一些函数并记账。
- **影响**：
  1. **生产可见**：agent 在快照副本记录 provider 失败/密钥失效，`GET /api/providers` 读活副本的空表 → 设置页红标与「密钥失效，请更新密钥」横幅**永远看不见真实故障**，`noteProviderSuccess` 的"清除故障"也清不到东西（跨副本无从对应）；
  2. **测试不可信**：`scripts/selftest.ts:1125` 用活目录 `new AgentRunner(...)`，执行器 `put` 在活副本、`recall_tool_result`（快照副本注册的）`get` 在快照副本 → 恒报"结果不存在或已淘汰"。即 HEAD 提交起 CI 的 selftest 就是红的（90 通过 / 1 失败）。
- **修复方案**（已实施）：新增内核原语 `kernel/shared.ts` 的 `sharedSingleton(key, make)`（globalThis 命名空间登记中心），把需要跨副本共享的模块级状态改为经它取得：
  ```ts
  export const resultStore = sharedSingleton('chat.resultStore', () => new ResultStore());
  const health = sharedSingleton('chat.providerHealth', () => new Map<string, ProviderHealth>());
  ```
  内核只提供机制、不含业务语义（边界自检 `selftest [boundary]` 仍通过）。
- **备选**：把这两处状态提升为 `service:*`（更"架构正确"，但消费方要从 import 改成解析服务，改动面大，且 `server/routes/providers.ts` 这类顶层 import 的写法仍会复发同类问题）。
- **契约补充**：插件若有需跨副本共享的模块级可变状态，一律 `sharedSingleton()`；纯函数与只读常量不受影响。已核过其余模块级状态：`goal-plan.plans`、`vision.store`、`search.dispatchers`、`tools-fs.rgAvailability`、`mcp` 连接表均只在同一副本内闭环使用（无 server/scripts 跨副本读写）；`core/skills` 的模块级 `flushNow/stopTimer` 另有重载覆盖问题，见 U11④。
- **验收**：`kernel/tests/shared.spec.ts` 用**同一份源码的两个不同路径副本**模拟双实例（复制文件并把相对 import 改写为绝对 file URL），断言 `put` 在 A、`get` 在 B 可见；provider-health 同理。

#### B14 [P1] 测试把运行时快照当源码测；脏快照无人回收

- **现象**：同一条 `npm test` 在不同时刻报 **362 / 438 / 539** 个用例；且 Batch 1 后出现"新 spec 用旧实现跑"的伪失败。
- **机制（两条叠加）**：
  1. `package.json` 的 test 脚本用 `core/*/tests/**/*.spec.ts` 形式 glob → 同时命中 `core/chat@<hash>/tests/*.spec.ts` 快照副本；
  2. 快照目录只在 reload 提交/回滚与卸载时剪枝（`plugin-loader.ts:1056,1075,1323,1425`），**注册/启动路径不剪枝**，`pruneOrphanSnapshot` 也只回收"owner 目录已消失"的孤儿 → 内容过期的脏副本长期驻盘（实测 `core/chat` 一度并存 4 个快照目录，其中一份是"含新 spec、不含新 fix"的组合，正是一次 stash 对照实验留下的）。
- **影响**：用例数与结果取决于磁盘残留状态，CI 不可复现；快照副本里的 spec 会与被测源码不一致。
- **修复方案**（已实施）：
  1. `plugin-snapshot.ts` 的 `SKIP_DIR` 增加 `tests` → spec **既不参与内容哈希、也不被复制进快照**（运行时永不 import 自己的 spec），从结构上消灭"快照里的测试"；
  2. `plugin-loader.ts:register()` 在生成快照后 `pruneSnapshots(dir, [snap.dir])` → 启动即回收该插件的历史快照，只留当前内容对应的一份；
  3. 新增 `scripts/run-tests.mjs` 作为 `npm test` 入口：显式枚举 `kernel/server/core/plugins` 下的 `*.spec.ts`，跳过 `@<hash>` 目录与 `node_modules/dist/coverage`，把确定的文件清单交给 `node --test`。
- **验收**：修复后源码树 spec 29 个 / 用例 **304 个**，连续运行计数稳定；`core/**/*@*/**/*.spec.ts` 命中数 = 0。
- **工作量**：0.5 天（已完成）。**风险**：`tests` 不入快照意味着任何"运行时 import 自己 tests 目录"的插件会失效——全仓 grep 无此用法。

### B-补. 执行中新确认的条目（B15–B17）与 A2 的加重事实

> 这四条都是**动手时才暴露**的：静态审查看不到「进程为什么不退出」，也看不到「双基座错位会同时打掉内核写保护」。列出以修正原清单的严重度判断。

**A2 的加重事实（原判 P0 偏低）**：`isProtectedWritePath` 同样只按 `sandboxRoot` 算相对路径。当前部署（沙箱根 `D:\DEEPSEEK`、项目根 `…\maharness\web-agent`）下，`write_file('maharness/web-agent/kernel/index.ts')` 的规范相对路径是 `maharness/web-agent/kernel/index.ts` —— **不命中 `kernel/` 前缀，内核写保护实际可绕过**。也就是说 README 的「内核写保护（自我接管防护）」与「`.env`/`data/` 不进上下文」两条承诺在同一处错位上同时失效。修复必须**双基座**（沙箱根 ∪ 项目根），只做敏感名单不够。
- 已实施：`kernel/sandbox.ts` 新增 `SandboxBases` / `relUnder` / `sensitiveTarget` / `isApprovalRequiredWritePath`，`isProtectedWritePath`、`isDeniedReadPath` 加可选 `projectRoot` 参数（向后兼容）；`core/tools-fs` 与 `server/routes/files.ts` 全部改为双基座；写侧敏感目标（`.env`、`data/**`）走**强制审批**（不受 `tools.writeRequiresApproval` 影响），HTTP 写接口因无审批语义直接 403。
- 回归：`kernel/tests/sandbox.spec.ts`（9 例），其中一例**显式断言旧行为**（单基座判 false）以钉住这个洞的成因。

**B15 [P1] `withTimeout` 不 `clearTimeout` → 进程跑完不退出**（已修）
- 机制：`Promise.race` 的定时器随胜者作废但从不清除，于是**每次** onLoad/onStart 都留一个 30s ref'd 定时器（16 插件 × 2 = 32 个）。`selftest` 打印完全文汇总后仍不退出即由此而来——表现为「验收门卡死」。
- 定位过程值得记录：`process._getActiveHandles()` 报 `handles=0`，一度误判为句柄泄漏；真相是 **Node 12+ 的 timers 不再是 libuv 句柄，不出现在该列表里**，必须用 `process.getActiveResourcesInfo()`（实测 32×`"Timeout"`）。
- 修复：胜者产生即 `clearTimeout` + `unref()` 双保险。

**B16 [P1] selftest 从不调用 `closeEnvWatcher`**（已修）
- `startServer` 早已导出该清理函数并在注释里点名「嵌入场景多次 start/stop 需要显式清理」，但 `selftest` 的 finally 只关了 server/store/kernel。修复：finally 补 `started?.closeEnvWatcher?.()`，并在 server 侧对 `.env` 目录 watcher 加 `unref()` 作纵深防御（漏关也不钉住循环）。
- 效果：`npm run selftest` 从「不退出」变为 **26 秒退出、exit 0**。

**B17 [P1] `ctx.cache` / `ctx.trace` 绕过服务仲裁**（已修）
- 与 A2 同类的"半截接管"问题：`buildContext` 直接把内核内置实例交给插件，而 `kernel.cache` 走解析层。插件 `ctx.provide('service:cache', impl, 10)` 接管后，同一子系统在进程内有两种身份。
- 修复：`buildContext` 的 `trace`/`cache` 改为**解析视图 getter**（复用不埋点的 `resolveView`，避免热路径重新引入 C1 噪声）。
- 回归：`kernel/tests/services.spec.ts` 新增「探针服务在调用时读 `ctx.cache.mark`」两例（接管生效 / 停用回退）。



#### C1 [P0] `service_call` 噪声占归档 96~99.5%，挤掉真实步骤

- **现象**：轨迹归档被簿记步骤灌满，真实 LLM/工具步骤被淘汰，前端"轨迹消失"并回退到慢路径。
- **证据（已复现，含运行时数据）**：
  - 产生点：`kernel/plugin-loader.ts:813-828` `traceServiceGet` 每次服务解析都 `startStep({ traceId:'', turn:0, type:'service_call' })` 并无条件 `finish`（入 ring、走 SSE、进 JSONL）；
  - **放大器**：`kernel/index.ts:107-116` 的 `cache/trace/budget` 是**解析视图 getter**（`resolveBuiltin` → `plugins.resolveService` → `traceServiceGet`）→ **每次读 `kernel.trace`/`kernel.cache`/`kernel.budget` 都写一条 service_call**（对自己所在 trace 的自观测）。全仓这三处访问点约 68/50/23。`ctx.cache`/`ctx.trace` 是裸实例（`kernel/index.ts:92-94`），不产生步骤——**用 `ctx.*` 还是 `kernel.*` 写插件会显著影响可观测性**，这本身就是个陷阱；
  - **高频触发源**：UI 每 2s 调 `/api/trace/stats`（`server/routes/trace.ts:27-29` 读 trace+cache 两次 = 3 条/次）、每 5s 调 `/api/stats`（`server/routes/stats.ts:11-67` 读 trace/cache/budget 共 5 处 = 5 条/次）；
  - **实测**：`data/traces/2026-09-10.jsonl` 1423 行中 1371 行（96.3%，按名分布 `service:cache 650 / service:chat 393 / service:trace 326`）；`2026-09-11.jsonl` 629 行中 617 行（98.1%）；`2026-09-29.jsonl` 406 行中 404 行（**99.5%**，时间跨度 300s → 1.35 步/秒，与"2s 轮询×3"完全吻合）。
  - **后果链**：噪声以 ~1.5 条/秒写入共享 ring（容量 1000，`kernel/trace.ts:11,55-56`）→ 约 11 分钟填满 → 真实对话步骤被 `shift` 挤掉 → `/api/trace?trace_id=X` 在 ring 里查不到（service_call 的 `traceId:''` 也不匹配）→ 回退 `queryArchive` → 主线程**整文件同步读**（C2）→ 面板"轨迹没了/变慢"；`stats().steps` 计数同样被灌水。
- **与文档的冲突**：`docs/ARCHITECTURE.md` §1.5.2b 明确写「Trace 解析**只在确有插件绑定时**才写 service_call 步骤（无接管 = 零额外开销）」——实现无条件写。**这一条可以直接按文档实现，不需要新设计。**
- **修复方案**：
  1. `traceServiceGet` 增加"是否真有插件接管"判定：`binding.pluginId !== KERNEL_PROVIDER_ID` 时才埋点（内核内置提供者不埋点）；保留一个调试开关 `trace.serviceCall: 'takeover'（默认）| 'always' | 'off'`；
  2. 统计类端点（`/api/trace/stats`、`/api/stats`、`/api/capabilities` 等轮询接口）改用**不埋点**的解析路径（例如 `resolveService(key, consumer, { trace: false })`），从根上消除"轮询产生轨迹"；
  3. `service_call` 步骤补上 `traceId`/`consumer` 语义（现在是空串 + `name:key`），否则即使埋点也没有关联价值（这也是审查报告 B5 的未修项）。
- **验收**：
  - 新增 `kernel/tests/services.spec.ts` 断言：内核内置提供者被解析时**不产生** trace 步骤；插件接管后解析**产生**且 `provider` 为插件 id；
  - 端到端：启动服务静置 2 分钟（前端轮询开着）→ 新增归档中 `service_call` 行数为 **0**；
  - 真实对话后统计 `service_call` 占比 < 5%。
- **工作量**：0.5 天。**风险**：低（改的是埋点，不动解析语义）；但若不一起改"统计端点用非埋点路径"，仅靠第 1 项仍会留下接管场景下的噪声。

#### C2 [P2] 归档回退是整文件同步读；归档无轮转；`flushTimer` 未 unref

- **证据**：`kernel/trace.ts:147-157` `queryArchive` 用 `readFileSync(整个文件).split('\n')` 再 `slice(-maxLines)` —— **20k 只是解析上限，I/O 是全文件同步读**，最多 14 个文件，全在主线程（当前单文件 0.01~0.92 MB，最坏数 MB）；`flush()` 按日期切文件、只追加（`:112-121`），全仓**无保留天数/大小上限**；`flushTimer`（`:96-101`）未 `unref`（对比 `kernel/budget.ts:55` 明确 unref）→ 最后一条步骤后事件循环至少多留 2s（对长驻 server 无感，对 CLI/嵌入式场景是"最多延迟退出 2s"）。
- **修复方案**：归档读取改流式/`readline` 或按需 tail；新增 `trace.retainDays`（默认 14）与单文件大小上限，`flush()` 时顺带清理；`flushTimer.unref()`。

#### C3 [P2] 统计口径不自洽

- **证据**：`server/routes/stats.ts:17` `overall` 只用 L1（hits/(hits+misses)）；`:76-79` L3 用 token 口径；`:87` `served = L1+L2+L3` 加总，而 UI 把它显示为「**本周**节省调用」（`ui/src/components/StatsView.tsx:87`），别处又称"历史累计"→ **同一数值两个时间窗**；`ui/src/components/TracePanel.tsx:141-142` 的回退口径 `cacheHits / max(1, llmCalls + toolCalls)` **把工具调用混进分母** → 系统性低估（有真实口径 `l3RealTokens` 时不会走到，属兜底路径）。
- **修复方案**：统一三层口径与命名（明确"会话/累计/本周"）；`served` 文案改为"累计"；轨迹面板回退口径分母去掉 `toolCalls`。

#### C4 [P2] 注释声称的 `factVersion` 快速路径不存在

- **证据**：`kernel/plugin-loader.ts:1091` 注释「签名比对以 factVersion 为前提：factVersion 未变 → 直接跳过（快速路径）」，但 `factVersion` 只在 `:189`（声明）、`:862-863`（自增）、`:384`（拼 `&r=`）、`:831-833`（外部读取）出现，`reloadChanged`/`recomputeSignature`/`primeSignatures` **一次都没读**。构造器订阅 `config.watch('*')`（`:223-229`）→ 任意 `config.set` 都会在 400ms 防抖后对**全部 started 插件**重算签名（约 30 个分量、微秒级，性能可忽略）。
- **影响**：不是性能问题，是**观测量与注释失真**——外部无法用 `getDependencyVersion()` 判断"是否需要调用"。且 `config.watch('*')` 让任意配置写入都触发一次全量签名重算。
- **修复方案**：实现快速路径（记 `lastSeenFactVersion`，未变直接返回 `[]`），或删掉注释。建议实现——它同时让 `bumpFact` 的语义变得有意义。

---

### D. 资源与性能

#### D1 [P2] `Budget.sessionCalls` 键永不删除

- **证据**：`kernel/budget.ts:69-83` 每次放行 `set(sessionId, sess)`，**键从不 `delete`**；被拒时（`:75-77`）提前 return 不回写。需修正的量级：每键数组长度恒 ≤3（永不增长），真实增长是"每会话一条 Map 记录"≈ **200~400 B/会话**（1 万会话 ≈ 2~4 MB，10 万 ≈ 20~40 MB）；进程重启清零（不落盘）；只有调用过委派工具的会话才被记录。
- **修复方案**：每次消费时顺带清理过期键（`if (sess.length === 0) delete`），或改用滑动窗口计数器。属"顺手修"，可延后。

#### D2 [P2] 价格表导致成本虚高 / 与实调模型脱钩

- **证据**：`kernel/modelCatalog.ts:27` `/^gpt-4o(-mini)?/` → mini 套 2.5/10（实际约 0.15/0.6，**虚高 ≈16×**）；`:35` `/^claude-(opus|sonnet|haiku)-4|^claude-4/` → haiku 套 3/15（虚高 ≈3×）；`:61-63` 未识别模型走 `FALLBACK 1/4`（编造值）。而 `core/chat/provider.ts:67-73` 另有正确的 `PRICE_TABLE`（mini 0.15/0.6）——两条路径谁生效取决于启动顺序（DB 注入后由目录价主导）。
- **熔断是否真的会误触发**：`totalCost` 累计用 `provider.prices`（`agent.ts:596`、`provider.ts:95-99`），`costBudget = maxSessionCost - 会话累计`（`chat.ts:86-90,321`），而 `budget.maxSessionCost` **默认 0 → 熔断默认关闭**。所以当前是**潜在**问题：只有用户显式配置了会话成本预算时才会提前撞线。
- **另一个独立问题**：`pricesFor(provider, model)` 已导出但**全仓无调用者** → 计价永远用 provider 默认模型单价；启用 `agent.modelRouting` 或 failover 换模型后，**实际调用的模型与计价模型不一致**，成本口径与真实用量脱钩（这条与熔断是否开启无关，统计面板的数字本身就是错的）。
- **修复方案**：价格正则拆细（mini/haiku 单独条目）；未识别模型不套编造价，改为"标记 unknown + 回退 provider 默认价 + 首次计价 warn"；把 `pricesFor` 接进 `estimateCost`（按本轮实际 `providerId@model` 解析价格）。

---

### E. 一致性与文档

> 本组问题不改变运行行为，但会**误导后续开发者与 AI agent**（文档点名的组件/表/端点不存在，会让人按错误地图改代码）。建议集中在 Batch 4/5 处理。

| ID | 问题 | 证据 | 修复 |
|---|---|---|---|
| **E1** [P1] | L1 阈值双口径：代码 **0.58**（`kernel/cache.ts:183`、`kernel/index.ts:68`、`server/routes/config.ts:20`），前端 **0.85**（`SettingsView.tsx:347` 兜底、`StatsView.tsx:114` 文案）；滑块范围 [0.5,1] 允许把 0.85 PATCH 进配置（`:58` 只 clamp 不纠偏） | 见左 | UI 兜底改 0.58、文案改 0.58（或直接读 `cfg.cache.l1Threshold`）；在滑块旁标注"低于 0.58 更难命中"。**注**：`docs/缓存体系设计.md:36` 的结论本来就是 0.58（`:31` 的 0.85 是被实测否决的反例），文档不构成第三个口径 |
| **E2** [P1] | README「安全模型（机器强制，不依赖提示词）」与实现不符：审批可被 A1 绕过、`.env` 可被 A2 写、HTTP 无鉴权 | `web-agent/README.md:60-66` | 先修 A1/A2，再按实际能力重写该节（含威胁模型边界） |
| **E3** [P2] | README 称 `context.maxTokens` 默认 30000，代码 5 处均为 **60000** | `README.md:42` vs `core/chat/agent.ts:330`、`server/routes/chat.ts:233,315`、`routes/config.ts:15`、`routes/stats.ts:14` | 统一为一个值（建议随代码改文档，因为 60000 已是既有行为） |
| **E4** [P2] | 内核件数 **5/6/7** 三值漂移；`ARCHITECTURE.md:77,337` 的"6"含 EffectScope 不含 Budget，`:59,354,708` 的"5"又是另一组；`kernel/index.ts:3` 自称 7（把逐插件实例化的 EffectScope 当内核单例）；`Kernel` 实际聚合 6 个 | 见左 | 统一为「内核聚合 6 件（bus/config/loader/trace/cache/budget）+ EffectScope 为逐插件实例 + 3 份契约件」并同步全文档 |
| **E5** [P2] | 文档 §6 列 4 张表，实际建 8 张；`cache_entries` 文档有代码无（`db.ts:3` 注释虚指）；`plugin_state` 建了但全仓零读写；`sessions` 文档缺 `provider` 列 | `ARCHITECTURE.md:608-616` vs `server/db.ts:96-137` | 表结构改为从 `db.ts` 生成/校对；删 `cache_entries` 注释；`plugin_state` 决定"使用或删除" |
| **E6** [P2] | 文档 §7 列 19 条端点，实际注册 **70** 条，整类缺失：providers(8)、personas(5)、rules(4)、evolve(4)、commands(2)、approvals(2)、git(3)、config/meta(4)、capabilities/nav/plugin-ui(5) | `ARCHITECTURE.md:622-645` | 生成式维护（从路由注册处导出清单） |
| **E7** [P2] | §8 点名的 6 个组件中，`ModelPicker`/`FileExplorer` **全仓无文件**，`SessionList`/`PluginPanel` 零引用 | `ARCHITECTURE.md:656` | 改为实际组件名（Menu / FilesView / TracePanel / ChatView…） |
| **E8** [P2] | §8 声称的"中断→继续任务→三步任务""子代理 3 层下钻""handoff 横幅"**无对应 spec**；`ui/` 下 20 个 `diagnose-*.mjs` 与 E2E 职责混淆（其自注"非 e2e 断言"） | `ARCHITECTURE.md:675-677`、`ui/e2e/` 仅 1 spec | 文档改为"手工诊断 + 1 个 spec"，把诊断脚本移入 `scripts/diagnostics/`；补 3 条关键 E2E（见 §5） |
| **E9** [P3] | README 让用户配 `config.json`（`agent.modelRouting`/`mcp.servers`），但仓库无该文件也无 `config.example.json`（与 `.env.example` 待遇不对称） | `README.md:124,127` | 增加 `config.example.json` |
| **E10** [P3] | `kernel/loop.ts:39` 注释的 `agent.stopped` 事件全仓无实现；版本号第 4 处字面量 `Sidebar.tsx:274`；`ui/package.json` 的 version 无人读取（改它不影响界面） | 见左 | 删残留注释；版本号单一来源（Vite `define` 注入 `package.json` version） |

### F. 前端与测试

| ID | 问题 | 证据 | 修复 |
|---|---|---|---|
| **F1** [P2] | 6 个组件零 import（死代码）：`FileTree`、`PluginPanel`、`SkillsPanel`、`StatsPanel`、`PersonaPanel`、`SessionList`（`PluginsView.tsx:17` 的 `PluginPanel` 是同名局部函数，不是引用） | `ui/src/components/` 22 文件 | 删除或移入 `legacy/`；`docs/积木哲学.md:97-98` 的退役清单只登记了已不存在的 `WorkbenchView`/`TodoBoardView`，应补登这 6 个 |
| **F2** [P1] | 与"诚实呈现（真实数据）"信条冲突：`StatsView.tsx:78` 硬编码假柱状图 `[36,44,28,52,48,60,64]`（7 柱）配 3 个标签 `Mon/Wed/Sun`；`:113,123,136` 三条 `cc-bar-fill` 无宽度绑定=假进度条；`:129` 同一位置在 rate% 与裸计数间切换；**币种双口径**：`StatsView.tsx:9` 与 `SettingsView.tsx:290` 用 `¥`，而 `voice.ts:229-233` 的 `money()` 论证过"定价是 USD，统一 `$`" | 见左 | 假图改为真实数据或删除；统一 `$`（推荐，与 provider 定价一致）；`¥` 若坚持需引入汇率与说明 |
| **F3** [P2] | `App.tsx` 1074 行 / 26 个 `useState` 是单点复杂度；27 个 `useCallback` 中 15 个依赖数组含 `toast`（sonner 模块级稳定引用 → 冗余但无害） | 见左 | 抽出 `useSessionStream`/`useApprovals`/`usePluginNav` 等 hooks；清理冗余依赖 |
| **F4** [P2] | `App.tsx:220` 轨迹步骤上限 200（`slice(-199)`），三层 span 树下钻场景可能先淘汰父步骤（只能走孤儿兜底）；`TracePanel.tsx:141-142` 回退口径分母含 `toolCalls` | 见左 | 上限可配 + 优先淘汰无子节点者；修正口径（见 C3） |
| **F5** [P2] | `watch()` 只监听用户插件目录（`kernel/plugin-loader.ts:1303-1306`）→ `core/**` 改动静默无效，与 `plugins/` 的"保存即热重载"体验不一致（文档已述"core 改动需重启"，但 UI 未提示） | 见左 | 或在 UI 插件详情页对 core 插件标注"改动需重启"；或把 core 也纳入监听（注意与内核写保护的关系） |

---

## 3. 误报澄清（怀疑已证伪，防止重复排查）

| 编号 | 曾经的怀疑 | 核查结论 |
|---|---|---|
| G1 | `plugin-snapshot.ts` 的 `SOURCE_EXT` 不含 `plugin.json`/`.md` → 改 `plugin.json` 不生效 | **驳回**。`register`（`loader:321`）与 `reloadInternal`（`:1023`）都从**源目录**重读 `plugin.json`；文件级监听事件也会定向触发 reload；`entry/requires/enabled/nav/limits/config` 全部每次重读生效。唯一残留语义是"模块级顶层读取自身目录非源码文件"的插件会拿到旧值——in-tree 无此写法 |
| G2 | 熔断插件调 `enable()` 会"静默成功" | **驳回（原表述错）**。`enableInternal`（`:1240-1251`）先按 state 抛错 → API 返回 400。**真问题在 reload 回滚分支**（已升级为 B3） |
| G3 | "L1 阈值文档里还有第三个口径 0.85" | **驳回**。`docs/缓存体系设计.md:36` 的结论就是 0.58，`:31` 的 0.85 是被实测否决的反例。真实矛盾是**代码 0.58 vs 前端 0.85**（E1） |
| G4 | 十进制/十六进制 IPv4（如 `http://2130706433/`）可绕过 providers 的 SSRF 校验 | **驳回**。WHATWG URL 会规范化为 `127.0.0.1` 并被 `isPrivateV4` 拦下。真实缺口是**重定向不逐跳复检**（A5）与 `web_fetch` 的 **IPv4-mapped IPv6 十六进制**（A3） |
| G5 | `StatsView` 用 6 位小数、`docs` 与代码在内核件数上完全失配 | **部分驳回**。6 位小数在**死组件** `StatsPanel.tsx:8`（属 F1 的死代码），不在 `StatsView`；内核件数是 5/6/7 三值漂移（E4），不是"文档一个值、代码一个值" |

---

## 4. 修复批次与执行计划

### 4.1 批次定义（写范围互斥，便于并行）

**Batch 1 — 可观测性护栏 + 核心正确性**（4 个写者，可并行）

| 者 | 条目 | 写范围 |
|---|---|---|
| 1-A | C1, C4 | `kernel/plugin-loader.ts`、`kernel/index.ts`、`server/routes/trace.ts`、`server/routes/stats.ts`、`kernel/tests/services.spec.ts` |
| 1-B | B1 | `core/chat/compact.ts`、**新增** `core/chat/tests/compact.spec.ts` |
| 1-C | B7, B11 | `kernel/bus.ts`、`kernel/tests/bus.spec.ts` |
| 1-D | B12 | `kernel/config.ts`、`server/routes/config.ts`、`kernel/tests/config.spec.ts`（新增）、`config.example.json` |

**Batch 2 — 安全收口**（6 个写者；A2/B10 同文件，须串行或同一写者）

| 者 | 条目 | 写范围 |
|---|---|---|
| 2-A | A1, A8, A10 | `core/powershell/index.ts`、**新增** `core/powershell/tests/assess-approval.spec.ts` |
| 2-B | A2, B10 | `kernel/sandbox.ts`、`core/tools-fs/index.ts`、`server/routes/files.ts`、`kernel/tests/sandbox.spec.ts`（新增） |
| 2-C | A3 | `core/search/index.ts`、**新增** `core/search/tests/ssrf.spec.ts` |
| 2-D | A4 | `core/mcp/index.ts`、**新增** `core/mcp/tests/env-approval.spec.ts` |
| 2-E | A5 | `server/routes/shared.ts`、`server/routes/providers.ts`、`server/tests/providers.spec.ts` |
| 2-F | A6, A7, A9 | `server/index.ts`、`server/routes/{approvals,workspaces,rules}.ts`、`server/secrets.ts`、`server/db.ts`、`kernel/skillsSync.ts` |

**Batch 3 — 功能与资源**（4 个写者；B3/B4/B8 同文件须串行）

| 者 | 条目 | 写范围 |
|---|---|---|
| 3-A | B2, D1 | `kernel/budget.ts`、`core/subagent/index.ts`、`core/parallel/index.ts` |
| 3-B | B3, B4, B8 | `kernel/plugin-loader.ts`（**须在 Batch 1-A 之后**）、`kernel/tests/loader.spec.ts` |
| 3-C | B5, B9 | `kernel/cache.ts`、`kernel/tests/cache.spec.ts` |
| 3-D | B6, D2 | `kernel/validate.ts`、`kernel/modelCatalog.ts`、`core/chat/provider.ts`、`kernel/tests/modelCatalog.spec.ts` |

**Batch 4 — 一致性与前端**（3 个写者）

| 者 | 条目 | 写范围 |
|---|---|---|
| 4-A | E1, E3, C3(UI 侧) | `ui/src/components/StatsView.tsx`、`SettingsView.tsx`、`TracePanel.tsx` |
| 4-B | F1, F2, F3, F4, F5 | `ui/src/**`（与 4-A 的 4 个文件不重叠） |
| 4-C | E4~E10 | `docs/**`、`README.md`、`config.example.json` |

**Batch 5 — 收口**：E2（按 A1/A2 修完后的真实能力重写 README 安全模型）+ 新增《已知边界》单一入口（把 B9 时代遗留、G4/G5/G8、本文 §7 的记录项汇总）。

### 4.2 顺序建议

1. **Batch 1 与 Batch 2 同时启动**（写范围不重叠；P0 安全项不该等可观测性）。若人力不足，先 Batch 2-A + 2-B（两个 P0）。
2. Batch 1-A 完成后才可启动 Batch 3-B（同文件）。
3. Batch 3 全部完成后启动 Batch 4。
4. 每批结束跑一次完整验收门（§6），全绿才进下一批。

### 4.3 提交纪律

- 每批一个 PR/一次提交，**带对应新增 spec**；提交信息按现有风格（`fix(scope): 中文说明`）。
- 每批结束由非本批写者执行**独立复验**（复核 diff + 跑验收命令），避免"自己改自己验"。
- 涉及安全语义的改动（A1/A2/A5/A6）必须在报告里写明"修复前的可达路径 + 修复后的断言"，便于回溯。

---

## 5. 回归测试矩阵

| 缺陷 | 测试文件 | 关键断言 |
|---|---|---|
| A1 | `core/powershell/tests/assess-approval.spec.ts`（新） | 4 个脚本块 payload + 6 变体 → `needsApproval=true`；10 条只读命令 → `false` |
| A2 | `kernel/tests/sandbox.spec.ts`（新）+ `core/tools-fs` 测试 | 长路径下的 `.env`/`data/secret.key` 读被拒、写需审批；正常文件不受影响 |
| A3 | `core/search/tests/ssrf.spec.ts`（新） | `[::ffff:7f00:1]` 等 6 个 URL 抛错；公网 URL 通过 |
| A4 | `core/mcp/tests/env-approval.spec.ts`（新） | spawn env 不含 `*_API_KEY`；默认需审批 |
| A5 | `server/tests/providers.spec.ts`（扩） | 重定向到私网被拒；豁免语义四处一致 |
| A6 | `server/tests/auth.spec.ts`（新） | 无 token 的变更请求 401；`workspaces` 拒绝盘符根 |
| A7 | `server/tests/secrets.spec.ts`（新） | 密文损坏 → API `hasKey:false`，不静默 |
| A9 | `kernel/tests/skillsSync.spec.ts`（新） | 非 SKILL.md 文件哈希不符 → 拒绝安装 |
| B1 | `core/chat/tests/compact.spec.ts`（新） | 压缩后 `messages[0]` 与原始 L0 逐字节相同；总 token 下降 |
| B2 | `kernel/tests/budget.spec.ts`（新） | 4 任务并行成功且只消耗 1 次会话配额；provider 不可用不扣配额 |
| B3 | `kernel/tests/loader.spec.ts`（扩） | 熔断态下 reload 不返回成功；注册表无 error 态实例 |
| B7 | `kernel/tests/bus.spec.ts`（扩） | 抛错监听器不影响后续监听器与返回值 |
| B12 | `kernel/tests/config.spec.ts`（新） | `set+persist` 跨实例保持；`setRuntime` 不落盘 |
| C1 | `kernel/tests/services.spec.ts`（扩） | 内核内置提供者解析不产生 trace 步骤；接管后产生 |
| C1（端到端） | 手工/脚本 | 静置 2 分钟后新增归档 `service_call` 行数 = 0 |
| E8 | `ui/e2e/`（新 3 spec） | 中断→续跑；审批卡出现→批准→执行；插件页三模式挂载/卸载 |

---

## 6. 验收指标（可量化，修复后回归）

| 指标 | 当前 | 目标 |
|---|---|---|
| 归档中 `service_call` 占比 | 96.3%~99.5% | **< 5%**（无接管时 0） |
| 静置 2 分钟产生的轨迹步骤数 | ~180 | **0** |
| 压缩后 L0 system prompt 存在率 | 超预算即丢失 | **100% 保留** |
| PowerShell 绕过 payload 通过率 | 4/4 免审批 | **0/4** |
| 长路径下项目 `data/` 读保护 | 不生效 | **生效** |
| `/api/config` 改动重启存活 | 0% | **100%**（显式用户改动） |
| `npm run typecheck` | 0 error | 0 error（不得回退） |
| `npm test` | 362 通过 | ≥ 362 + 本表新增用例，0 失败 |
| `npm run selftest` | 断言通过 | 断言通过 |
| `npm run eval`（golden 回归） | 4/4 | 4/4 |

---

## 7. 明确"只记录不修"的项（附理由）

| 项 | 理由 |
|---|---|
| R1 `Budget.sessionCalls` 键不删 | 量级 200~400 B/会话、重启清零；顺手修可以，不值得单独排期 |
| R2 `SOURCE_EXT` 不含 `plugin.json` | 已证伪（G1）：改动确实生效 |
| R3 `enable()` 熔断插件 | 已证伪（G2）：真实问题在 B3 |
| R4 `queryArchive` 整文件同步读 | 当前单文件 ≤0.92 MB、最坏数 MB；**但若 C1 不修**，归档会持续膨胀，届时需与 C2 一起处理 |
| D1 bis `bail` 的 Promise 语义 | 无生产调用者；建议只加测试固化语义（已归入 Batch 1-C） |
| 隔离域（Cordis isolate） | 前序报告已决策不实施（`configWith` + 会话/轨迹作用域已覆盖主用例），本文不重复论证 |
| G5/G8 类"语义模型更薄"的项 | 同上，属已评估的取舍，不是缺陷 |
| warmup 自动降级"不落盘" | **这是正确行为**（B12 的修复必须保持：自动降级走 `setRuntime`，不得持久化，否则一次探针失败会永久关闭全局预热） |

> 附带记录（不在清单中单列，但建议在修 B12 时一并评估）：`server/routes/warmup.ts:101` 的判据 `probe && miss > 0` 过苛——网关部分命中（`hit>0 && miss>0`）是常态，一次探针就把全局 `cache.warmup` 置 off（进程级，重启恢复）。建议改为 `probe && hit === 0`，并把降级范围限定到该 provider。

---

## 8. 验证方法与复现命令

```powershell
# 静态与单测（本文基线实测：0 error / 362 通过）
cd D:\DEEPSEEK\maharness\web-agent
npm run typecheck
npm test

# 产品级冒烟（隔离数据目录，不触发 LLM）
npm run selftest

# golden 回归（确定性回放，零 API 成本）
npm run eval

# C1 复现：统计归档里 service_call 占比（本文使用的命令）
cd data\traces
Get-ChildItem *.jsonl | Sort-Object Name | Select-Object -Last 6 | ForEach-Object {
  $svc=(Select-String -Path $_.FullName -Pattern '"type":"service_call"' -AllMatches).Count
  $tot=(Get-Content $_.FullName | Measure-Object -Line).Lines
  "{0}  total={1}  service_call={2}" -f $_.Name,$tot,$svc
}

# A1 复现（只读判定，不执行命令）：调用 assessApproval 的判定逻辑跑用例表
# → 见新增 spec：core/powershell/tests/assess-approval.spec.ts
```

**本次审查用到的关键证据文件**（可复核）：
- `data/traces/2026-09-07.jsonl`（246 行 / 241 service_call）、`2026-09-08`（48/41）、`2026-09-09`（182/125）、`2026-09-10`（1423/1371）、`2026-09-11`（629/617）、`2026-09-29`（406/404）
- `data/traces/2026-08-15.jsonl:1068`（A10 误拦实证）
- 启动日志（`data/` 同级 `maharness-server.log`）：`沙箱根目录: D:\DEEPSEEK` 与 `[env] 监听 D:\DEEPSEEK\maharness\web-agent`——A2 基座错位的直接证据

---

## 9. 覆盖边界与待确认

**已覆盖**：kernel 全部 20 文件、16 个 core 插件、server 全部路由与 db/secrets、ui 全部组件与构建配置、docs 8 篇 + README。

**未覆盖 / 留待后续**：
1. **动态验证**：A1/A2/A3/A6 都是静态判定链确认，未做真实调用复现（受"只读核查"约束）。修复前建议由非作者在本机做一次"只读复现"（例如只用 `assessApproval` 的纯函数判定，不实际执行 payload）。
2. **真实 provider 端到端**：L3 前缀缓存真实命中率、failover、Anthropic 原生路径未在真实网络下验证。
3. **多进程/多实例**：`pidPrefix` 4 位十六进制（65536 空间）在"多实例共享 traces 目录"时约 1/65536 概率重号；未做压力验证。
4. **第三方依赖**：`better-sqlite3`/`undici`/`express`/`react` 等的已知漏洞未审。
5. **ARS 技能包内容**：上游零修改落位，其脚本与提示词内容未审（按项目约定另行跟踪）。
6. **前端无障碍与视觉回归**：仅做了静态审读，未做 axe/视觉基线对比。

**本文自身的局限**：所有行号基于基线 `1540590`；若期间有提交，行号可能漂移，请以 `git log -1` 与检索关键字定位。

---

## 10. 修复进度（滚动更新）

| 批次 | 状态 | 条目 | 验收证据 |
|---|---|---|---|
| **Batch 1** | ✅ 完成 | C1 · C4 · B1 · B7 · B11 · B12 · **B13 · B14 · B15 · B16**（执行中新发现并一并修复） | 提交 `3179f27` + `a6abbb8` |
| **Batch 2** | ✅ 完成 | A1 · A2 · A3 · A4 · A5 · A6 · A7 · A8 · A9 · A10 · B10 · **B17 · B18** | 提交 `abd4523` |
| **Batch 3** | ✅ 完成 | B2 · B3 · B4 · B5 · B6 · B8 · B9 · C2 · D1 · D2 | 提交 `abd4523` |
| **Batch 4** | ✅ 完成 | E1 · E3 · C3 · E4–E9 · F1 · F2 · F4 · F5 · E10 · A6 前端接线 | 提交 `98de899` + `086a4cc` |
| **Batch 5** | ✅ 完成 | E2（README 安全模型按真实能力重写 + 已知边界单一入口） | 提交 `011ac22` |
| **F3 收尾** | ✅ 完成 | useApprovals hook 抽取 + 14 处冗余依赖清理 | 提交 `6e18ef3` |
| R1–R4 | ➖ 按原定级「只记录不修」 | R1 会话键不删（200–400 B/会话、重启清零）；R2 已证伪；R3 已证伪（真问题在 B3，已修）；R4 整文件同步读（已随 C2 改为尾部按块回读，故**实际已受益**） | 见 §7 |

**§1 的全部条目均已处置**（P0 5 + P1 16 + P2 24 + P3 4，其中 1 条已证伪不计入）；
执行中另**新发现并修复 B17、B18 两条**。

**最终验收（提交 `6e18ef3` 时实测）**：

| 门禁 | 结果 |
|---|---|
| `npm run typecheck` | **0 error** |
| `npm run ui:typecheck` | **0 error** |
| `npm test` | **673 通过 / 0 失败**（37 个 spec 文件） |
| `npm run selftest` | **91 通过 / 0 失败**，27 秒正常退出 |
| `npm run eval` | **4 通过 / 0 失败** |
| `npm run ui:build` | 通过（Vite 生产构建，421 modules） |
| C1 端到端指标 | 真实 server + 模拟 UI 统计轮询 30 轮 → 归档仅 **1** 条 `service_call`（`external → chat` 依赖边）；再轮询 30 轮**增量 0**。修复前：每轮 3~5 条、占比 96~99.5% |
| 提交数 | 7（基线 `1540590` 之后） |

### Batch 2–3 执行中新确认的条目

**B17 [P1] `ctx.cache` / `ctx.trace` 绕过服务仲裁**（已修）
`buildContext` 直接把内核内置实例交给插件，而 `kernel.cache` 走解析层——插件接管后同一子系统在进程内有**两种身份**，「137 处调用点零改动即可被接管」只对 `kernel.*` 那一半成立。修复：`trace`/`cache` 改为解析视图 getter，并复用**不埋点**的 `resolveView`（否则会经新入口把 C1 噪声再引进来）。回归：`services.spec.ts` 新增「探针服务在调用时读 `ctx.cache.mark`」两例（接管生效 / 停用回退）。

**B18 [P1] Windows 上 `npx` 类 stdio MCP server 根本起不来**（已修）
A4 执行过程中顺带发现并**当场实测坐实**：`spawnSync('npx')` → ENOENT（PATH 上只有 `.cmd` 垫片）、`spawnSync('npx.cmd')` → EINVAL（Node 因 CVE-2024-27980 禁止无 shell 启动 `.bat/.cmd`）。后果是 `config.example.json` 推荐的 `npx -y @modelcontextprotocol/server-filesystem` 在 Windows 上必然失败，而报错只是笼统一句"进程启动失败"。修复：win32 上非 `.exe` 命令一律经 cmd.exe 解析，命令行由我们自行组装（含空格/分隔符的参数整体加引号），错误信息回显实际命令行。回归：`core/mcp/tests/security.spec.ts` 的 4 例 `buildSpawnPlan`。

**A2 的加重事实（成因比原判更严重，但定级 P0 已够）**
`isProtectedWritePath` 与 `isDeniedReadPath` 都只按 `sandboxRoot` 算相对路径。当前部署（沙箱根 `D:\DEEPSEEK`、项目根 `…\maharness\web-agent`）下，`write_file('maharness/web-agent/kernel/index.ts')` 的规范相对路径**不命中 `kernel/` 前缀**——即"内核写保护（自我接管防护）"本身就能被长路径绕过，不只是 `.env`/`data/`。所以修复必须**双基座**（沙箱根 ∪ 项目根），只补敏感名单不够。`kernel/tests/sandbox.spec.ts` 里有一例**显式断言旧的单基座行为**（判 false）以钉住成因，防止将来"顺手简化"回退。

### Batch 2–3 改动清单（要点）

| 域 | 改动 | 关联 |
|---|---|---|
| PowerShell 判定 | 白名单 cmdlet 的**参数位不再当数据**：脚本块只允许 `$_` 属性 + 比较/逻辑运算符安全子集；出现类型字面量 / `::` / `$()` / 赋值 / 调用运算符即需审批。黑名单改为在**去引号扫描串**上逐段匹配；拆段改为引号与脚本块感知；补齐 New-Object/Add-Type/Start-Process/Invoke-Command 等"参数位即代码"动词 | A1 · A10 |
| 沙箱 | 双基座判定 + `sensitiveTarget`/`isApprovalRequiredWritePath`（写侧敏感门）+ `resetCoreEditGuard` + 沙箱根缺失报错归因修正；tools-fs 与 HTTP 文件接口同步；`policyApproved` 进 ToolContext 并在 powershell/tools-fs handler 做纵深防御 | A2 · A8 · B10 |
| SSRF | `isPrivateAddress` 逐组解析并还原 IPv4-mapped/6to4/NAT64 内嵌 v4，补齐保留段，IPv6 fail-closed；`web_fetch` 体积上限改流式；providers 两处 `fetch` 改逐跳复检 + 跨源剥凭据头；四处豁免统一 | A3 · A5 |
| MCP | env 白名单透传（`inheritEnv` 逃生口）；工具默认需审批；win32 `taskkill /T` 回收孙进程；协议版本单一常量；HTTP 传输 URL 校验；`buildSpawnPlan` 解决 npx | A4 · B18 |
| HTTP/密钥 | 变更类端点可选 token 门（`MAHARNESS_API_TOKEN`）；工作区根拒盘符根/家目录且 `/switch` 复检历史危险行；审批一次性凭据；通配 allow 需显式确认；`icacls` 收 ACL、`keyBroken` 暴露、已有密文拒绝静默重建密钥 | A6 · A7 |
| 技能供应链 | 先落临时目录校验完整清单再原子替换；`force` 不再跳过校验 | A9 |
| 配额 | 「全部前置校验通过后才扣」+ `refund` 句柄；`run_parallel` 改为一次委派扣 1 次（此前 4 任务必然失败并白烧 3 次）；空会话键回收 | B2 · D1 |
| 事务/签名 | reload 回滚分支补提交检查；`watchConfig` 签名改稳定序列化 + 通配键展开 + 走 override 链；`keepActive` 以磁盘新 manifest 为准 | B3 · B4 · B8 |
| 缓存/校验 | L1 向量分支补动作方向校验；embedding 失败降级而非掀翻对话；维度不一致告警；`validate.ts` 未知 type 改 fail-closed 并支持 type 数组 | B5 · B6 · B9 |
| 可观测/资源 | 归档尾部按块回读（不再整文件同步读）+ `trace.retainDays` 轮转与热更新；成本按**实际调用模型**计价（接上无人使用的 `pricesFor`）、mini/haiku 独立价、价格来源不明告警 | C2 · D2 |
| 测试 | 新增 `approval-bypass`/`sandbox`/`budget`/`shared`/`security`(MCP+B18)/`ssrf`(search+server 交叉比对)/`auth` 等 spec；扩展 `trace`(C2)/`services`(B17)/`config`/`bus`/`compact` | 全部 |

### Batch 1 改动清单

| 文件 | 改动 | 关联缺陷 |
|---|---|---|
| `kernel/plugin-loader.ts` | `traceServiceGet` 只在**确有插件接管**时埋点（新增 `trace.serviceCall` 口径 takeover/always/off）；`reloadChanged` 实现 factVersion 快速路径（失败则作废，保留重试）；构造器的 `config.watch('*')` 补 `bumpFact()`（快速路径的正确前提）；`register()` 回收历史快照 | C1 · C4 · B14 |
| `core/chat/compact.ts` | 头部 system（L0）不参与压缩且在输出中保留（`headIsSystem` + `prefixEnd` 双处修正） | B1 |
| `core/chat/tests/compact.spec.ts` | **新增** 7 例：L0 逐字节保留、降级截断保 L0、锚点在头部/中部两种情形、无头部 system 的旧行为、未超预算原样返回 | B1 |
| `kernel/bus.ts` | `serial`/`bail`/`waterfall` 监听器错误**隔离并继续链**（深度错误仍上抛）；`bail` 拒绝把 async 监听器的未决 Promise 当短路结果（跳过 + 去重告警）；`parallel` 保持聚合语义并注明理由 | B7 · B11 |
| `kernel/tests/bus.spec.ts` | 新增 6 例（含"抛错前已调 next → 下游结果照常返回"、"递归深度错误不被隔离吞掉"） | B7 · B11 |
| `kernel/config.ts` | 重写：`set()`（运行期，不落盘）与 `setPersistent()`（用户改动，防抖 + 原子落盘 + 坏文件拒绝覆写）分离；构造器归一化点路径平铺键 | B12 |
| `server/routes/config.ts` | `PATCH /api/config` 全部键改走 `setPersistent` | B12 |
| `config.example.json` / `.gitignore` | 新增示例配置；`config.json` 列入忽略 | B12 · E9 |
| `kernel/tests/config.spec.ts` | **新增** 11 例（分层读取、平铺键、落盘跨实例保持、合并保留手写键、对象值整子树覆盖、坏文件拒写） | B12 |
| `kernel/shared.ts` | **新增** `sharedSingleton()`：跨模块副本的共享单例原语 | B13 |
| `core/chat/result-store.ts`、`core/chat/provider-health.ts` | 模块级单例改经 `sharedSingleton()` 登记 | B13 |
| `kernel/tests/shared.spec.ts` | **新增** 3 例：用同源码的两个路径副本模拟双实例，断言状态确实共享 | B13 |
| `kernel/plugin-snapshot.ts` | `SKIP_DIR` 增加 `tests`（spec 不入哈希、不入快照） | B14 |
| `scripts/run-tests.mjs` + `package.json` | `npm test` 改为显式枚举源码树 spec、跳过 `@<hash>` 快照目录 | B14 |
| `kernel/tests/services.spec.ts` | 新增 3 例锁定 `service_call` 埋点口径 | C1 |

**Batch 1 的量化效果**（对照 §6 指标）：

| 指标 | 修复前 | 修复后 |
|---|---|---|
| 归档中 `service_call` 占比 | 96.3%~99.5% | 静置轮询期 **0**（接管场景才记录）——待跑一轮服务复测确认 |
| 压缩后 L0 system prompt | 超预算即丢 | 保留（单测断言逐字节相等） |
| 钩子监听器抛错 | 掀翻整轮对话 | 隔离并继续（链不断在半路） |
| `PATCH /api/config` 重启存活 | 0% | 100%（运行期自动降级仍不落盘） |
| `npm test` 可复现性 | 362/438/539 漂移 | 固定 304 |
| `npm run selftest` | 90 通过 / **1 失败** | **91 通过 / 0 失败** |

**待复测项**：`service_call` 占比需要启动一轮服务并静置 2 分钟后统计新归档，留待 Batch 2 结束后的整体验收一起做。

