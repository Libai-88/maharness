# maharness 开发质量系统性审查报告

> 审查对象：`D:\DEEPSEEK\web-agent`（maharness v0.1.0）
> 参考基线：`D:\DEEPSEEK\cordis-main\cordis-main\packages\core`（Cordis 核心，含 loader/hmr 生态）
> 审查依据：《maharness 核心框架升级：超越 Cordis（零新依赖）》设计文档
> 审查日期：2026-08-17
> 方法：全量通读 kernel/（2693 行）、核心 server/core 相关文件，对照 cordis core 源码逐机制比对，运行 typecheck 验证

---

## 一、总体评价

**结论先行：maharness 的内核是一个"设计成熟度显著高于平均自研项目"的薄内核**——代码质量、注释纪律、边界处理、可观测性意识都在线（typecheck 全绿、零第三方依赖、架构文档 v2.2 完整）。设计文档的**四大改造方向 + 缓存优化全部落地，无一项欠账**，且多数实现质量超出文档预期。

但存在三个结构性短板，构成与 Cordis 的真实差距：

1. **零自动化测试**（最大差距，P0）
2. **`.env` 热更新实际失效**（智能重载的最大功能漏洞，P0）
3. **配置无 schema 校验 + 无上下文隔离域**（语义模型比 Cordis 薄，P1）

下面逐项展开。

---

## 二、设计文档兑现度核对（全部落地 ✓）

| 设计项 | 文档要求 | 实际实现 | 状态 |
|---|---|---|---|
| 方向① 依赖驱动智能重载 | depSignature/factVersion/bumpFact/recomputeSignature/reloadChanged | `plugin-loader.ts` L56-95、L633-668 全部实现；KernelLike 暴露；server/index.ts L147 `.env` 变更走 `reloadChanged()` | ✅ 落地 |
| 方向② 五语义事件总线 | serial/bail/parallel/waterfall/onPhase | `bus.ts` L86-198 全部实现；类型进 `types.ts` EventBusLike | ✅ 落地 |
| 方向② 生产首用点 | agent.before_llm/after_tool 走 waterfall | `agent.ts` L212-222 `emitHook()` 经 `bus.waterfall` 派发，L324/L719 两处调用 | ✅ 落地 |
| 方向③ 服务级调用追踪 | providers 增值 + resolveTraced + service_call span | `plugin-loader.ts` L65-72 ProviderBinding、L444-459 traceServiceGet；`types.ts` StepType 含 `'service_call'` | ✅ 落地 |
| 方向④ 上下文配置合并 | configWith + override 链 + effect 逆元撤销 | `plugin-loader.ts` L340-352 configWith、L365-381 override 链（最内层优先）、scope 逆元撤销 | ✅ 落地 |
| 缓存 D1 | warmup 三态 off/light/auto + 自适应探针降级 | `warmup.ts` L92-104：auto 首轮 max_tokens=1 探针，miss>0 自动降级 off 并写 config | ✅ 落地 |
| 缓存 D2 | worldState 末尾追加；warmup 触发放宽到 ≥3 | `chat.ts` L275 worldState 作为 contextMessages 追加；L383-384 `seqAcc.length >= 3` | ✅ 落地 |
| 缓存 D3 | promptKey 加 model 维度 | `agent.ts` L428/L587 `sha256(model + systemPrompt)` | ✅ 落地 |

**额外亮点（超出文档预期）**：chain 串行队列取代 check-then-act（L476-480）；reload 提交/回滚时新实例继承链尾防并发丢失（L562/L593）；rescan 互斥防 watch 风暴（L79）；入口 hash busting 消除"未变化却重复膨胀"的模块泄漏（L216-225）；reloadChanged 快速路径跳过 factVersion 未变（L631 注释）。

---

## 三、与 Cordis 的差距矩阵（核心结论）

### 3.1 maharness 已确立的优势（客观成立）

| 维度 | Cordis | maharness | 评估 |
|---|---|---|---|
| 事务性热重载 | 无显式事务，卸载失败即半加载 | 两阶段 + 旧模块回滚，永不半加载（L552-612） | **领先**，文档 claim 成立 |
| 依赖签名覆盖面 | epoch 只追踪 inject 服务集合 | service + capability 集 + 配置键 + requires 四类分量 | **领先**，覆盖面更广 |
| 服务调用追踪 | getTraceable Proxy 隐式追踪，运行时开销高 | 显式调用点（resolveTraced），开销可控、可写盘 | **领先**，工程取舍更优 |
| 事件中间件兼容性 | waterfall 以参数注入 next，破坏监听器签名 | `e.next` 挂事件对象，旧 `(e)=>void` 监听器零改动升级 | **领先** |
| 缓存/成本工程 | 无 | L1/L2/L3 三层 + 真实命中双口径 + 熔断 + 预热 | **领先**（Cordis 不涉此域） |

### 3.2 真实差距（按严重度排序）

| # | 差距 | Cordis 实现 | maharness 现状 | 严重度 |
|---|---|---|---|---|
| G1 | **自动化测试体系** | `packages/core/tests/` 12+ spec（dispose/events/fiber/invoke/isolate/plugin/reflect/service/shadow），loader 3 spec，vitest + 覆盖率 + CI 语义 | **零测试文件**。仅有 `scripts/selftest.ts` 冒烟脚本（无断言框架、无覆盖率、无回归保护）；设计文档验证清单也是手动的 | **P0** |
| G2 | **`.env` 热更新失效** | loader 配置系统统一走配置管线 | depSignature 无 env 分量（depHooks 仅 service/caps/cfg/requires，L299/L318/L331）；且 `core/search` 的 dispatcher/API key 是**模块顶层常量**（L20-31），入口 hash 不变 → import 命中 ESM 缓存 → 即使 reload 也拿不到新值 | **P0** |
| G3 | **配置 schema 校验** | `Plugin.Config` + standard-schema，无效配置抛 ValidationError（含 path 级 issues，fiber.ts L34-46）；Fiber.update() 也校验 | 插件配置零 schema 声明（manifest 无 config 字段），validate.ts 只校验工具 outputSchema。配置错误全靠插件自防 | **P1** |
| G4 | **上下文隔离域（isolate）** | `ctx.isolate(name)` 生成隔离符号链，同名服务在不同隔离域可共存（context.ts L65-69）；`intercept()` 原型链配置拦截 | 服务键全局唯一（providers Map 一 key 一 provider，L85）；configWith 是插件级 overrides 数组，非上下文级 | **P1** |
| G5 | **声明式依赖注入** | `inject: ['foo']` 数组 / @Inject 装饰器，Fiber 构造即知依赖集；依赖缺失 → 插件自动 INACTIVE 等待，出现即激活（fiber.ts L385-397） | `ctx.inject(key, cb)` 命令式订阅，插件需自行在 onLoad 调用；依赖缺失只通知回调，无自动状态机 | **P2** |
| G6 | **类型化事件表** | `declare module './context'` 事件键控类型，事件名/参数编译期检查（events.ts L16-33） | 事件为裸 string，无事件表类型；插件事件全靠约定 | **P2** |
| G7 | **Service 抽象** | `Service<T>` 基类：构造自动 provide、config 拦截解析、callable invoke、mixin（service.ts） | 服务 = 任意 value + 手动 provide；无类型化服务契约 | **P2** |
| G8 | **内核可拦截性** | internal/* 事件族（internal/dispatch 可拦截任何事件派发、internal/update 配置更新 waterfall、internal/get/set 属性访问钩子） | 只有 plugin.*/service.*/kernel.* 业务事件；普通 emit 不可被插件拦截改写（仅显式 waterfall 可） | **P2** |

### 3.3 差距的定性说明

- **G1 是唯一"硬伤"**：maharness 的机制复杂度（五语义事件、LIFO 逆元栈、事务回滚、签名重算、串行队列）与 Cordis 同级甚至更高，而 Cordis 靠 15+ spec 保住这些机制的可回归性。maharness 目前只有 typecheck + 冒烟，**机制改动无任何护栏**。这是"工程成熟度"与 Cordis 最实质的差距。
- **G2 是智能重载的"功能空洞"**：设计文档把 `.env` 变更作为 reloadChanged 的主打场景（"改 .env 一个 key → 只重载关心的插件"），但签名里根本没有 env 维度——结果从"全量重载"退化为"永不重载"，比原方案更糟（原方案至少生效）。且 search 插件的模块顶层常量让 reload 本身也救不了它。
- **G3-G8 是"语义模型更薄"而非"错误"**：maharness 明确取舍了单会话单循环架构，多上下文树/隔离域/声明式依赖在单机工具型场景收益有限。但若未来要多会话隔离（parallel 插件已存在）或插件间同名服务共存，G4 会成为瓶颈。

---

## 四、mahraness 自身缺陷清单（与 Cordis 无关）

### P0

**B1. `.env` 变更不会触发任何插件重载（功能失效）**
- 位置：`server/index.ts` L147 → `plugin-loader.ts` recomputeSignature L633-643
- 根因 1：depHooks 无 env 分量 → 签名不变 → reloadChanged 返回空列表。
- 根因 2：`core/search/index.ts` L20-31 dispatcher/TAVILY_API_KEY 是模块顶层常量，且 `entryUrl` hash 基于入口文件内容（.env 不影响）→ 即使 reload 也命中 ESM 模块缓存，新 key 永不生效。
- 影响：改 Tavily key / SEARCH_PROXY 必须重启进程，与"改动即生效"的心智模型矛盾，也推翻了设计文档验证清单第 3 条。
- 建议：① depHooks 增加 env 声明能力（`ctx.watchEnv(name)`，分量 `env:${name}@${process.env[name]}`，server 侧 .env 变更后 bumpFact 再 reloadChanged）；② reload 时对 entryUrl 追加强制失效参数（如 `&r=${factVersion}`）使模块记录刷新，并约定**插件只在 onLoad/onStart 函数体内读 env，不做模块顶层常量**；③ search 插件改为惰性读取（每次请求时读 process.env 或经 ctx.watchEnv）。

**B2. 零测试（同 G1）**
- 建议：先为三个最容易回归的机制补 spec——① EventBus 五语义（短路/中间件/onPhase 三阶段/深度保护）；② EffectScope（LIFO 逆序/幂等/child 级联/armed 后 add no-op）；③ PluginLoader 事务回滚 + reloadChanged 签名比对（用临时目录构造坏插件验证回滚）。用 node:test + tsx 即可，零新依赖，符合项目纪律。

### P1

**B3. disable→enable 后 depHooks 残留（签名漂移）**
- 位置：`stopInternal` L516-533 未清空 `inst.depHooks`；`enableInternal` L734-735 重跑 runLoad 时再次 push → 数组累积两份，旧分量引用已撤回服务（`@none`）→ 下次 reloadChanged 触发不必要的 reload。
- 建议：stopInternal 里 `inst.depHooks = []`；顺带确认 configOverrides 已由 scope 逆元清空（是）。

**B4. 注释与代码漂移（低危但伤可信度）**
- `chat.ts` L382 注释"≥5 条消息才有缓存价值" vs L384 代码 `seqAcc.length >= 3`；设计文档写 3。统一为 3 并删旧注释。
- `plugin-loader.ts` L33 注释引用旧文件行号"plugin-loader.ts L491"，已与现状不符。

**B5. service_call span 无 traceId 上下文**
- `traceServiceGet` L449 用 `traceId: ''`——服务调用边（谁→谁）无法关联到具体会话/轨迹，可观测性打折扣。建议：调用链上溯源（如从消费方 ctx 的调用栈/最近 traceId 注入），至少给 server 层消费方（chat 服务）传入当前会话 traceId。

### P2

**B6. reloadChanged 是"轮询式"而非"事件驱动"**
- Cordis 的 epoch 变化即时驱动 reload/unload；maharness 需要外部显式调用 reloadChanged（目前仅 .env 路径）。config.watch 内的 `bumpFact()`（L334）目前没有消费者——config 键变化不会主动触发 reloadChanged，除非某处调用。建议在 config.changed 事件挂一个 `void reloadChanged()` 的慢路径（防抖）。

**B7. `getContextConfig` 对 override 为对象时的点路径只读第一层**
- `readOverride` L365-373 支持 `a.b.c` 点路径，但 `configWith({chat:{temperature:0.2}})` 读取 `chat.temperature` 时先命中 `layer['chat.temperature']`（无），再走点路径逐层——正确；但 `section()` L242-249 的 Object.assign 浅合并，嵌套对象会被整体覆盖而非深合并。文档未承诺深合并，属已知限制，标注即可。

**B8. EventBus 插入排序在监听器极多时 O(n²) 累积**
- 当前插件规模无碍；若未来监听器上千（trace.step 类高频事件），建议改桶结构。可暂缓。

---

## 五、与 Cordis 对标的"未借鉴项"评估（可接受）

| Cordis 能力 | 未借鉴原因 | 评估 |
|---|---|---|
| Context Proxy 反射（属性访问即服务解析） | 显式方法更直白、无 Proxy 开销，maharness 已论证 | ✅ 合理取舍 |
| @Inject 装饰器 / 类插件形态 | manifest 式生命周期 + 函数插件更贴近 agent 场景 | ✅ 合理取舍 |
| loader 配置分组/isolate/tree | 单机单进程无多租户配置需求 | ✅ 合理取舍 |
| hmr（Vite 集成） | Node ESM 无卸载 API，hash busting 已是工程极限 | ✅ 已尽力（文档自述残余限制） |
| internal/dispatch 全局拦截 | maharness 用显式 waterfall 覆盖核心拦截场景 | ⚠️ 扩展性略弱，见 G8 |

---

## 六、改进路线图（按优先级）

```
Phase 1（保命）—— 已完成（2026-08-17，见 §8）：
  ☑ 补测试：EventBus 五语义 / EffectScope / reload 事务回滚 / depSignature 重算（node:test，零新依赖）
  ☑ 修 B1：env 依赖声明 + 惰性 env 读取约定 + search 插件改造
  ☑ 修 B3：stopInternal 清 depHooks
  ☑ B9 缓解：reload 内容变化警告 + 契约文档化（选型评估见 §8.2，接受现状）

Phase 2（补语义）—— 已完成（2026-08-17）：
  ☑ 配置 schema：manifest 加 config 字段（JSONSchema 子集，复用 validate.ts 的 check 引擎）
  ☑ config.changed 挂 reloadChanged 慢路径（B6，400ms 防抖）

Phase 3（对齐 cordis 深层能力）：
  ☑ 类型化事件表（KernelEvents 契约 + bus keyof overload，string 兼容过渡）
  ☑ Service 抽象基类（构造即注册 + 类型化 config 读取，不破坏现有 capability 形态）
  ⬜ 隔离域 —— 评估后不实施（决策与触发条件见 §8.2b）
```

---

## 八、修复执行记录（2026-08-17，Phase 1 已执行）

### 8.1 已修复

| 项 | 修复内容 | 验证 |
|---|---|---|
| B1 env 热更新失效 | ① `ctx.watchEnv(name, cb?)` 依赖声明（`types.ts` / `plugin-loader.ts`：depHooks 分量 `env:name@version` + 即时订阅回调）；② `PluginLoader.bumpEnv(names?)`（env 版本递增 + 订阅者通知 + bumpFact）；③ `server/index.ts` .env 变更走 dotenv.parse diff → `bumpEnv(changed)` → `reloadChanged()`；④ search 插件 dispatcher 惰性化（按 SEARCH_PROXY 值缓存复用，不再模块顶层常量）+ 声明 `watchEnv('TAVILY_API_KEY'/'SEARCH_PROXY')`；⑤ reload 时 `forceFresh`（URL 加 `&r=factVersion` 打破模块缓存） | 单测：bumpEnv 触发 reloadChanged、订阅回调即时收到新值、无参 bumpEnv 全量生效 |
| B3 depHooks 残留 | `stopInternal` 清空 `inst.depHooks` / `forceFresh`（enable 重部署时重新登记，不翻倍） | 单测：disable→enable 后 depHooks 保持 2（不翻倍） |
| B4 注释漂移 | chat.ts「≥5 条」→「≥3 条」；loader 顶部过时行号引用修正 | typecheck |
| B2 零测试（部分） | `kernel/tests/` 三个 spec（bus 五语义 19 例 / scope 8 例 / loader 事务+智能重载 7 例），`npm test` 零新依赖（node:test + tsx） | **40/40 通过**（追加 6 例）；typecheck 通过；selftest 断言通过 |
| 深度保护错误被吞 | `bus.ts` emit 中带 DEPTH_ERROR 标记的递归深度错误向上传播（符合注释意图，打断事件风暴可被调用方感知） | 单测：`assert.throws(emit, /递归深度/)` |
| 配置 schema 校验（G3） | `PluginManifest.config` 字段（JSONSchema 子集，复用 validate.ts 引擎）；`runLoad` 前置校验 `config.<id>.*`，不合规 → 注册失败清理 / 热重载回滚或 error 态 | 单测 4 例：合规启动 / required 缺失失败 / minimum 违反失败 / 热重载坏配置 error 态 |
| B6 config.changed 慢路径 | `PluginLoader` 构造时 `config.watch('*')` + 400ms 防抖 → `reloadChanged()`；dispose 退订 | 单测：config.set 后自动触发依赖驱动重载（onLoad 重跑） |
| 类型化事件表（G6） | `KernelEvents` 事件契约（15 个核心事件）+ `bus.emit/emitAsync` keyof 泛型 overload（string 兼容过渡） | typecheck：现有调用点全部通过（错型即编译报错） |
| Service 抽象基类（G7） | `kernel/service.ts`：构造即 `ctx.register({kind:'service'})` + 类型化 `config()/configGet()`；EffectScope 自动撤销 | 单测：resolveService/capabilities 可解析、停用自动撤回 |
| B9 缓解（部分） | reload 提交时入口 hash 变化 → 明确警告「tsx 复用旧模块记录」；契约写入 plugin-authoring SKILL.md（onLoad 内读配置、不做顶层常量） | selftest 验证 search 插件按契约改造后正常 |

### 8.2 审查中发现的新问题（P0，缓解中）

**B9. tsx 运行时会 strip 模块 URL 的 query——hash busting 机制整体失效**
- 实测：`node --import tsx` 与 `npx tsx` 下，`import('file:///a.ts?v=aaa')` 与 `import('file:///a.ts?v=bbb')` 命中**同一个模块记录**（V2 内容不执行，返回 V1）。纯 Node 原生下行为正确（两个独立模块）。
- 影响：① 插件文件热重载（watch 触发 reload）在 dev/start（均为 tsx）下**实际不生效**——import 命中旧模块记录，改动不加载；② 本报告 forceFresh 的打破缓存设计在 tsx 下无效。
- 已实施的缓解（2026-08-17）：① reload 检测入口 hash 变化并打印明确警告（不再静默失效）；② 插件契约写入 plugin-authoring SKILL.md（onLoad/onStart 内读配置与 env、不做模块顶层常量；配置/env 维度热重载有效，文件内容维度需重启）；③ search 插件按契约改造（dispatcher 惰性化 + watchEnv 声明）。
- 剩余选型（未实施，评估结论）：
  1. **切 Node 原生 TS 运行**（`node --experimental-strip-types`）：不可行——项目 import 均为无扩展名相对路径（原生 ESM 要求显式 `.ts` 后缀，全量改造高风险），且 tsconfig `moduleResolution: Bundler` 依赖 tsx 的 resolver；
  2. **入口代理文件**：不可行——代理 re-export 原入口时，原入口（pathname key）仍命中旧模块记录，问题未解决；
  3. **接受现状（已选）**：以契约保证配置/env 维度热重载，文件内容维度热重载依赖 `tsx watch`（dev，进程重启式）或手动重启。

### 8.2b 隔离域（G4）评估决策——不实施

- 目标（Cordis isolate）：同名服务在不同上下文可共存。maharness 服务键全局唯一（providers Map），实现隔离域需将注册表改为 (domain, key) 二维，波及 inject/provide/resolveService/traceServiceGet/depSignature 全链路，风险高。
- 现有替代已覆盖主要用例：**上下文级配置差异由 configWith override 链提供**（方向④，角色级服务默认值）；**会话级状态隔离由 sessionId/traceId 作用域提供**（L1 缓存 scope、子代理独立 traceId）。
- 触发条件（未来若实施）：出现「同一进程内两个不同实现的同名服务并存」的真实需求（如多工作区各自 chat 服务）。届时以服务键命名空间（`域:key`）实现，不影响现有单域语义。

### 8.3 验证结果

```
npm run typecheck  → 0 error
npm test           → 40/40 pass（kernel/tests/：bus 19 / scope 8 / loader 13）
npm run selftest   → 断言全部通过（web_search 网络项 informational；Windows trash 清理报错为环境噪音，与改动无关）
```

---

## 九、结论

maharness 在**机制设计**上实现了对 Cordis 局部超越（事务回滚、四维依赖签名、显式调用追踪、事件中间件兼容性），在**工程纪律**上（注释、边界、可观测、零依赖）也高于同类自研项目。它与 Cordis 的差距不在"机制强弱"，而在**可回归性（无测试）**与**两个具体功能漏洞（env 热更新失效、depHooks 残留）**。按本报告 Phase 1 补齐后，"超越 Cordis"的 claim 在单机 agent 场景下可以站得住。
