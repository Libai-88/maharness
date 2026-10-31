# 插件与技能生态

关联登记项：PL-01、PL-02、PL-03、PL-04、PL-05、PL-06。

## 现状证据

插件热加载、EffectScope、服务接管、自扩展和 `vendor` 技能包已存在；现场插件完全信任，`core/` 不在普通目录监听范围，技能同步只校验 `SKILL.md`，缺少 SDK、兼容矩阵和能力发现标准。

## 目标

插件可发现、可安装、可验证、可回滚、可观察；技能具备输入输出契约、权限声明和评测用例。

## 执行

1. 定义 manifest v1：入口、版本、API 兼容、权限、网络域、文件范围、配置 schema、健康检查。
2. 提供插件 SDK 类型、脚手架、示例、生命周期测试工具和诊断命令。
3. 将加载前校验、哈希/签名、权限审批、坏版本回滚和依赖冲突纳入 loader。
4. 为技能定义 metadata、触发条件、工具白名单、输出 schema 和 eval case。
5. 明确 `core`、`plugins`、`vendor` 的升级与热加载边界。

## 验收

第三方示例插件可从安装到卸载全程完成；权限越界、版本不兼容、坏版本均有可读错误和自动回滚；技能至少有一个成功和一个拒绝 case。

## 依赖、兼容和回滚

依赖 05 的权限模型和 11 的 SDK/文档门禁。manifest 从 v1 起做向前兼容校验；现有现场插件由兼容扫描器生成初始 manifest，不自动升级其权限。插件更新保留上一份源码/manifest 快照，加载失败恢复旧版本。目标：核心 API 100% 有类型声明，示例插件安装成功率 >= 95%，坏版本恢复成功率 100%。

## 范围、迁移与指标

范围包括 loader、manifest schema、SDK、脚手架、技能注册表、权限审查和生命周期诊断；不把未声明能力默认为可用。

迁移按插件逐项生成 manifest，旧插件仅在本机 trusted 模式兼容运行；安装前保留源码、依赖锁和 manifest 快照。

指标：核心 API 类型覆盖率 100%，示例插件安装成功率 >= 95%，坏版本恢复成功率 100%，权限越界拒绝率 100%。

## 测试与完成定义

测试覆盖安装、卸载、热加载、冲突、坏版本恢复、权限越界、技能正例/拒绝例和 SDK 构建。PL-01 至 PL-06 均有实现提交、兼容矩阵、自动化验证、文档和回滚路径后关闭。

插件 manifest 支持可选 `permissions.capabilities` 名称白名单；loader 在 `ctx.register` 阶段拒绝未授权 capability/name 并记录审计事件，拒绝后清理插件已登记效应。未声明权限的旧插件按 trusted 兼容模式加载。确定性评测通过临时插件验证越权注册被拒绝且能力不进入 registry。该能力不隔离插件代码；插件仍可访问 `ctx.kernel`，运行时 API 的完整授权仍未完成。

PL-01 兼容范围补充（2026-10-31）：`PluginManifest` 支持可选 `compatibility.api.min/max`，宿主插件 API 当前为 `1.0.0`。loader 在加载前校验完整 semver、范围顺序及宿主版本是否落入范围；未声明范围的既有插件继续兼容。`kernel/tests/loader.spec.ts` 覆盖兼容、越界和格式错误，专项 `28/28`，`npm run typecheck` 与 `git diff --check` 通过。SDK、脚手架和完整迁移文档仍待完成。

PL-02 脚手架补充（2026-10-31）：`scripts/plugin-scaffold.mjs create <id>` 生成最小插件目录，`validate <dir>` 校验 manifest、入口、API 兼容范围和权限声明；生成目标已存在时拒绝覆盖。脚手架校验专项覆盖有效形状、宿主 API 不兼容和入口路径穿越；本地命令已接入 `plugin:scaffold`/`plugin:validate`，真实 loader 集成示例和完整 SDK 类型包仍待完成。

PL-02 真实加载补充（2026-10-31）：脚手架导出 `createPlugin` 供自动化验证；新增集成回归在仓库插件目录生成临时插件，由真实 `Kernel/PluginLoader` 加载并核对 `started` 状态及 `<id>_hello` capability，随后清理插件和加载快照。脚手架专项 `3/3`、`npm run typecheck`、`git diff --check` 通过。完整 SDK 类型包、参考插件和安装/卸载全流程仍待完成。

PL-02 SDK 入口补充（2026-10-31）：新增 `kernel/plugin-sdk.ts` 公共入口，统一导出宿主 API 版本、服务键和插件契约类型；脚手架模板与 `plugin-authoring` 技能改用该入口。SDK/脚手架定向测试 `4/4`、`npm run typecheck`、`git diff --check` 通过。参考插件及安装/卸载全流程仍待完成。

PL-02 参考插件补充（2026-10-31）：新增 `plugins/reference-hello` 最小 TypeScript 参考插件，使用 `kernel/plugin-sdk`，manifest 声明 API 兼容范围和 capability 白名单并默认停用；真实 loader 回归覆盖扫描、显式启用、工具可见和停用撤回，专项 `1/1`，manifest validate、`npm run typecheck`、`git diff --check` 通过。安装/卸载全流程仍待完成。

PL-02 安装卸载链路补充（2026-10-31）：脚手架集成回归覆盖生成、真实 loader 加载、capability 注册和 `PluginLoader.uninstall`；卸载后 registry、插件目录及快照均清理，专项 `3/3`、`npm run typecheck`、`git diff --check` 通过。SDK 细化、发布包和更完整的安装来源校验仍待完成。

PL-02 验收（2026-10-31）：`kernel/plugin-sdk.ts` 完整转出插件公共类型与服务键；脚手架提供 create/validate；`plugins/reference-hello` 提供默认停用的参考实现；自动化回归覆盖脚手架生成、manifest 校验、真实 loader 加载、capability 注册、卸载及目录/快照清理。SDK、参考插件和脚手架专项 `5/5`，`npm run typecheck`、`git diff --check` 通过。文档：[plugin-authoring/SKILL.md](../web-agent/core/skills/builtin/plugin-authoring/SKILL.md)。回滚为删除新增 SDK、参考插件、脚手架及测试并恢复旧类型入口。

PL-03 UI 诊断补充（2026-10-31）：`ui/e2e/plugin-errors.spec.ts` 通过 mock 依赖缺失插件状态，验证插件管理详情页同时展示错误原因和修复建议，Playwright 专项 `1/1` 通过。插件 id 冲突的可解释错误回归和完整失败恢复 UI 证据仍待补齐。

PL-03 冲突诊断补充（2026-10-31）：重复插件 id 现在进入 `PluginLoader` 结构化诊断，并通过新增 `/api/plugins/diagnostics` 展示；原 `/api/plugins` 数组契约保持兼容。loader 专项 `29/29`、插件错误 UI E2E `1/1`、后端/前端 typecheck 和 UI build 通过。完整失败恢复 UI 证据仍待补齐。

PL-03 验收（2026-10-31）：依赖缺失、入口错误、重复 id 冲突均有可读诊断；loader 回滚保留旧版本并有回归覆盖。新增诊断端点与插件管理页展示保持 `/api/plugins` 数组兼容，`kernel/tests/loader.spec.ts` `29/29`，`ui/e2e/plugin-errors.spec.ts` `2/2`，后端/前端 typecheck、UI build 和 `npm test` 通过。回滚为删除诊断端点、前端诊断区及对应测试并恢复原 API 实现。

PL-04 验收（2026-10-31）：loader 回归确认用户 `plugins/` 投影为 `watched=true` 且保存后自动热重载，`core/` 投影为 `watched=false` 且修改不触发热重载；技能索引支持配置 `skills.vendorDir` 的隔离路径，临时 vendor 包版本替换后经缓存失效重新索引可见，且不进入 PluginLoader。边界专项 `32/32`、技能专项 `4/4`，`npm test` `828/828`、后端/前端 typecheck、`git diff --check` 通过。回滚为移除配置覆盖点及 vendor 回归测试，恢复固定路径。

PL-05 验收（2026-10-31）：技能索引公开 `triggers`、`appliesWhen`、`rejectWhen`、`input`、`output`，frontmatter 兼容连字符与下划线键；五个内置技能均声明触发、适用、拒绝及输入输出契约。缺失字段的旧技能保留可发现性并返回 `contractWarnings`。`core/skills/tests/index.spec.ts` 契约专项 `3/3`，`npm test` `827/827`，后端/前端 typecheck、`git diff --check` 通过。回滚为移除契约字段、告警逻辑、内置 frontmatter 与对应回归测试。

PL-01 验收（2026-10-31）：manifest v1 的入口、版本、API 兼容范围、权限白名单和配置 schema 均有 loader 与脚手架校验；旧 manifest 保持 trusted 兼容，坏版本在热重载中回滚。兼容矩阵、迁移和回滚说明见 [manifest-v1-compatibility.md](manifest-v1-compatibility.md)。loader 专项 `31/31`、脚手架专项 `3/3`，`npm run typecheck`、`git diff --check` 通过。

PL-06 静态审查补充（2026-10-31）：`kernel/plugin-review.ts` 为 `create_plugin` 增加高风险源码拦截和 capability 白名单审查；通过审查的生成插件默认停用，使用 `enable_plugin` 显式试运行。审查专项 `3/3`、`npm test` `831/831`、后端/前端 typecheck、`git diff --check` 通过。进程隔离试运行与生命周期回收仍待完成。

PL-06 验收（2026-10-31）：自扩展生成链路先执行静态风险审查和 capability 白名单检查，再在独立 Node 子进程的临时 Kernel 中试运行；试运行成功后才写入生产 `plugins/`，生产 manifest 保持 `enabled:false`，由 `enable_plugin` 显式激活。审查 `3/3`、隔离试运行 `2/2`，`npm test` `833/833`、后端/前端 typecheck、`git diff --check` 通过。回滚为移除审查器、trial runner、生成链路接入及对应测试。
