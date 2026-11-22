# maharness 质量审查（2026-11-21）

审查对象：`D:\DEEPSEEK\maharness`（`maharness` 分支，HEAD `3c51de9`，v0.2.0）
审查方式：只读代码 + 实际执行全部本地门禁（未修改产品源码；运行 `ui:build` 重建了 `ui/dist` 构建产物）
范围：内核与插件边界、server 宿主层、AI 社会/劳动组织/复盘、数据层、前端、测试与工程化、依赖安全

## 一、总体结论

**工程底座扎实，本轮 11 项门禁全部通过，没有发现可直接触发的功能或安全缺陷。** 主要风险不在"有没有 bug"，而在三处结构性缺口：

1. **质量门禁不完整**：无 ESLint/Prettier/Biome，CI 的质量门只有 `tsc` + 测试；前端 118 个源文件 / 16,826 行**没有一个单测**，只靠 133 条慢速 E2E 兜底。
2. **安全关键文件的覆盖率偏低**：`plugin-loader` 39.84%、`skillsSync` 21.85%、`sandbox` 36.56%、`task-verifier` 26.14%——正是插件边界、供应链与验收所在。
3. **文档/模板与自动门禁互相冲突**：README 与内置 `plugin-authoring` 技能教插件写 `kernel/types`，但边界测试只允许 `kernel/plugin-sdk`，照文档写的插件会被门禁判失败。

| 维度 | 判断 | 依据 |
| --- | --- | --- |
| 功能正确性 | 良好 | 1538 用例 0 失败；E2E 133/133；确定性回放 28/28 |
| 安全 | 良好 | 安全回归 402/402；威胁模型映射检查通过；边界由 AST 测试真守 |
| 依赖安全 | 良好 | 生产依赖 0 漏洞；仅 1 个 UI 构建期 dev 依赖告警 |
| 可维护性 | 中等 | 4 个文件 >1,500 行；内核规模已超出"薄内核"表述 |
| 可测试性 | 前后端失衡 | 后端 82.35% 行覆盖；前端 0 组件测试 |
| 文档一致性 | 中等 | 三处插件导入路径冲突；HANDOFF 计数漂移；CHANGELOG `[Unreleased]` 残留 |
| 性能/规模 | 本地单用户可接受 | 未做压测；`tick` 与列表查询硬上限 1000 条 |

## 二、本轮实际执行（证据）

| # | 命令 | 结果 |
| --- | --- | --- |
| 1 | `npm run typecheck` | 通过（`strict` + `noUnusedLocals/Parameters`） |
| 2 | `npm run ui:typecheck` | 通过 |
| 3 | `npm test` | **1538 用例 / 1537 通过 / 1 跳过 / 0 失败**（109 秒） |
| 4 | `npm run test:security` | 402/402 |
| 5 | `npm run check:boundaries` | 2/2（server→core、core/plugins→kernel 两条边界） |
| 6 | `npm run check:threat-model` | 通过 |
| 7 | `node scripts/check-doc-facts.mjs` | 通过 |
| 8 | `npm run plugin:validate`（reference-hello、workbench） | 通过 |
| 9 | `npm run plugin:lock:verify` / `skill:lock:verify` / `skill:eval` | ok / ok / 5/5 |
| 10 | `npm run selftest` | 90/90 |
| 11 | `npm run eval:ci` | 28/28 |
| 12 | `npm run e2e`（Playwright，单 worker） | **133/133**（3.6 分钟） |
| 13 | `npm run test:coverage` | 行 **82.35%** / 分支 80.35% / 函数 81.74% |
| 14 | `npm run ui:build` | 通过（14.27 秒，产物已按页面与语言分包） |
| 15 | 依赖漏洞审计 | 生产 **0**；dev **1** 条 moderate |
| 16 | 数据库实查 | 58 张表、`user_version=16`、`schema_migrations` 2 条 |

跳过的那 1 条是"下载与网络观测（完整 Chromium）"，需 `MAHARNESS_TEST_DOWNLOAD=1`，属预期跳过，不是缺陷。

本机 `npm audit` 自身不可用（运行环境自带的 npm 缺少内部模块 `./cache/policy.js`，与项目无关）。改用 npm 官方 advisories bulk API 对前后端锁文件里 **842 个包名**复核，结论见 §4 P3。

## 三、值得保留的工程能力

- **类型约束真实生效**：生产代码里显式 `: any` 仅 13 处、`as unknown as` 45 处（不含测试），空 `catch {}` 9 处，`TODO/FIXME` 仅 1 处——不是靠 loose 模式糊过去的代码库。
- **边界不是口号**：`kernel/tests/dependency-boundary.spec.ts` 用 TypeScript AST 扫描，禁止 kernel 跨到 core/server/ui、禁止 core/plugins 绕过 SDK；`server/tests/boundary.spec.ts` 强制 server 只能经 5 个 host adapter 触达 core。
- **确定性与可复现**：回放型 eval 零 API 成本、E2E 固定单 worker、`SocietyService`/`OrganizationService` 注入 `now`、时区与 DST 有显式策略（gap 前移、overlap 取更早一次）。
- **安全投入有测试背书**：审批一次性凭据、SSRF 逐跳复检与 IP pinning、路径沙箱、MCP 默认审批、插件清单权限与进程隔离，共 402 条安全回归。
- **数据层**：不可变 SQL 迁移 + `manifest.json` checksum + `schema_migrations` 审计表 + 迁移前快照，v14 及以下 fail-closed。

## 四、发现（按优先级）

### P1-1 缺少 lint / 格式化门禁

**证据**：`web-agent/` 与 `ui/` 下没有 ESLint / Prettier / Biome 配置；`package.json` 里 `check:quality` 只有 `typecheck + check:boundaries`；CI 的 quality job 同样没有 lint 步骤。

**影响**：代码风格、未使用导出、`console` 残留、可疑模式（如 `==`、隐式 `any` 边界）只能靠人眼；跨 78k 行源码，这会持续产生低价值 review 噪音。

**建议**：引入 Biome（配置少、单命令、比 ESLint 快），先只开 `recommended` + `noUnusedImports` + 生产代码禁 `console`（`scripts/`、`server/index.ts` 启动日志豁免），`npm run lint` 接入 CI 与 `check:quality`。

### P1-2 前端测试结构失衡

**证据**：`ui/src` 118 个文件 / 16,826 行，**0 个单测/组件测试**（`*.test.*` / `*.spec.*` 计数为 0，E2E 目录除外）；全部保障是 133 条 Playwright 用例，单 worker 跑一次 3.6 分钟。覆盖率报告里 ui 只有 `run-status.ts` 等零星文件被间接覆盖。

**影响**：`api.ts`（429 行）、`workbench-api.ts`（677 行）、`App.tsx`（919 行）这类逻辑只能靠慢速 E2E 兜底，回归反馈环过长，重构意愿会被测试成本压住。

**建议**：引入 `vitest` + `@testing-library/react`，优先覆盖 `api.ts` / `workbench-api.ts` / `markdown` 工具函数 / `useSSE` 这类纯逻辑，再补 3 个核心组件（Composer、Workbench、Settings 的纯展示分支）；E2E 只留跨端流程。

### P1-3 安全关键文件覆盖率偏低

覆盖率低于 55% 的源文件共 50 个，其中与边界/供应链直接相关的：

| 文件 | 行覆盖 | 规模 |
| --- | --- | --- |
| `kernel/skillsSync.ts` | 21.85% | 672 行 |
| `kernel/task-verifier.ts` | 26.14% | — |
| `kernel/tool-discovery.ts` | 28.00% | 171 行 |
| `server/routes/plugins.ts` | 32.60% | — |
| `kernel/plugin-process.ts` | 33.78% | 426 行 |
| `kernel/validate.ts` | 35.60% | 178 行 |
| `kernel/sandbox.ts` | 36.56% | — |
| `kernel/plugin-loader.ts` | 39.84% | **1,922 行** |
| `kernel/compact.ts` | 40.30% | — |

**影响**：整体 82% 很好看，但缺口恰好落在"插件现场写、现场加载"这条最容易被自己改坏的路径上；`plugin-loader` 是最大的单文件，也是覆盖最差的关键文件之一。

**建议**：为这 8 个文件补路径级用例（加载失败回滚、半加载清理、快照剪枝、锁文件漂移、进程插件崩溃、沙箱越界），并在 CI 增设"指定文件最低行覆盖 ≥70%"的门，而不是只看全局数字。

### P2-4 插件导入路径：文档、内置技能与门禁互相冲突

**证据**：
- `web-agent/README.md:193` 示例：`import type { Plugin } from '../../kernel/types'`
- 内置 `core/skills/builtin/plugin-authoring/SKILL.md:56,71,95`：明确要求"SDK 类型用 `../../kernel/types` 的 type import"
- 实际仓库插件与脚手架：`plugins/reference-hello/index.ts`、`plugins/workbench/index.ts`、`scripts/plugin-scaffold.mjs:38` 全部用 `kernel/plugin-sdk`
- 门禁：`kernel/tests/dependency-boundary.spec.ts:28` 只放行 `kernel/plugin-sdk`，其余 `kernel/*` 一律 `assert.fail`

**影响**：Agent 的自我扩展路径正好走这套文档与技能——按文档写出的插件会立刻被 `npm run check:boundaries` 判失败，表现为"照着说明做反而报错"。

**建议**：把 README 与 `plugin-authoring` 的三处统一改为 `../../kernel/plugin-sdk`；再加一条测试：从文档/技能里抽取示例代码做类型编译，防止再次漂移。

### P2-5 结构热点仍在，且集中在制度、存储与加载器

| 文件 | 行数 |
| --- | --- |
| `kernel/plugin-loader.ts` | 1,922 |
| `server/services/organization/service.ts` | 1,704 |
| `server/services/society/index.ts` | 1,649 |
| `server/db.ts` | 1,293 |
| `server/run-service.ts` | 849 |
| `ui/src/App.tsx` | 919 |
| `ui/src/components/SettingsView.tsx` | 895 |

对比 2026-11-19 的审查，`society` 已从 2,531 行降到 1,649 行、`experience` 从 1,639 降到 1,036——拆分在推进，但 `plugin-loader`、`organization/service`、`db.ts` 仍未动。

**建议**：`plugin-loader` 按"清单校验 / 内容快照 / 进程宿主 / 热重载"四段拆；`db.ts` 按聚合根拆 store；`organization/service` 把评分卡与福祉下沉到已存在的 `projections.ts`。这三处拆完，修改成本会明显下降。

### P2-6 "薄内核"的口径已经漂移

**证据**：`kernel/` 有 59 个源文件 / 10,697 行，除声明中的"6 个状态件 + 3 份契约"外，还包含 `task-contract`、`task-verifier`、`tool-journal`、`tool-replay`、`execution-pool`、`model-call`、`skillsSync`、`fssearch`、`write-lock`、`content-safety` 等。README 与 ARCHITECTURE 仍用"内核极薄"表述。

**影响**：内核仍是**依赖方向**上的干净边界（这一点有测试保证），但"薄"已不成立；继续按旧口径加文件，会让"什么该进内核"失去判据。

**建议**：写一条 ADR 明确内核判据（只放机制与跨插件契约，不放具体能力），并把 README/ARCHITECTURE 的口径改成"内核=机制与契约（59 文件）"，或把非机制件下沉到 core。

### P2-7 文档计数与变更日志漂移

**证据**：
- `HANDOFF.md:49` 写"1536 通过、2 跳过"，实测 1538 用例 / 1537 通过 / 1 跳过。
- `CHANGELOG.md` 的 `[Unreleased]` 段仍挂着 API-04、SEC-02、SSE 审计、部署模式等条目，而这些在 0.2.0 之前就已发布；0.2.0 条目本身写得很准确。

**影响**：交接文档与变更历史是外部判断"现在能不能信"的主要依据，具体数字一旦漂移就会削弱信任。

**建议**：HANDOFF 的数量改为由脚本写入（复用 `eval:release:report` 的思路），或只写"以 `npm test` 输出为准"；发布时把 `[Unreleased]` 清空或移入对应版本。

### P3-8 `.plugin-trial-*` 临时目录未被忽略

**证据**：`kernel/plugin-trial.ts:33` 在**项目根**用 `mkdtemp(join(projectRoot, '.plugin-trial-'))` 建试运行目录，`finally` 里清理；但 `.gitignore` 只覆盖了 `core/*@*/` 与 `plugins/*@*/`，不含 `.plugin-trial-*`。我在跑测试套件期间，直接在 `web-agent/` 下观察到一个含 117 个文件的 `.plugin-trial-96tMay`（随后被正常清理）。

**影响**：进程崩溃、断电或强制结束时会留下上百个未跟踪文件，让 `git status` 变脏，也容易在清理时误删。

**建议**：`.gitignore` 增加 `.plugin-trial-*/`。

### P3-9 两处可读性小瑕疵

- `server/db.ts:1374` 在 SQL 模板里直接拼常量前缀（`LIKE '${SECRET_PREFIX}%'`）。当前只拼内部常量，无注入风险，但改成参数绑定更稳、也便于后续复用。
- `server/services/society/*` 的列表查询统一用硬上限 1000 条（`societyTasks(..., 1000)`、`societySchedules(..., 1000)`），没有分页。单租户本地规模无碍，但这是明确的扩展天花板，建议在文档里标注为已知上限。

### P3-10 唯一的依赖告警（dev-only）

npm 官方 advisories 复核结果：842 个包名中只有 1 条——`minimatch`（moderate，globparts 放大导致 ReDoS）。实际命中的是 `ui/package-lock.json` 里的 **10.2.6，且标记为 dev 依赖**（构建工具链），后端安装的是 3.1.5 / 5.1.9，不在影响范围。

**建议**：随下次 UI 依赖升级修掉即可；生产依赖无需动作。

## 五、建议路线

1. **一周内（低风险、直接收益）**
   - 加 Biome + `npm run lint`，接进 CI 与 `check:quality`。
   - README 与 `plugin-authoring` 的插件导入路径统一为 `kernel/plugin-sdk`，并加"文档示例可编译"测试。
   - `.gitignore` 补 `.plugin-trial-*/`。
   - HANDOFF 计数改为脚本生成或去掉具体数字；清空 CHANGELOG `[Unreleased]`。
2. **两周内（补齐测试结构）**
   - 前端引入 vitest + Testing Library，先覆盖 `api.ts`、`workbench-api.ts` 与 3 个核心组件。
   - 给 P1-3 列出的 8 个关键文件补路径级用例，CI 增加"指定文件行覆盖 ≥70%"门。
3. **一个月内（结构收敛）**
   - 拆 `plugin-loader`、`db.ts`、`organization/service`。
   - 写 ADR 明确"什么能进内核"，同步修正 README/ARCHITECTURE 的"薄内核"表述。

## 六、未验证范围与边界

- **真实模型 live 评测未跑**：`eval:live`、`eval:experience:v2`、`eval:organization:live` 需要 API key 且产生真实成本，本轮只验证了确定性回放（28/28）与自检（90/90）。因此"模型行为质量"不在本次结论内。
- **CI 远端结果未核对**：只验证了本地等价命令；GitHub Actions 的实际绿灯需要远端权限。
- **未做渗透测试与压测**：安全结论来自代码审读 + 402 条回归，不代表第三方渗透结论；多租户并发、大文件、慢盘下的表现未测。
- **`npm audit` 本机不可用**：结论来自 npm 官方 advisories bulk API 的等价复核（842 包），不等价于 `npm audit` 的完整依赖树语义。
- **只读审查**：未修改任何产品源码；`ui/dist` 因执行 `ui:build` 被重建（构建产物，已在 `.gitignore`）。

## 七、修复进度（2026-11-21 修复轮）

> 本节由上轮审查之后执行的修复补齐。每条给出「做了什么 / 证据 / 剩余边界」，命令输出均为本机实测。

### P1-1 缺少 lint / 格式化门禁 —— 已修

- 新增 `web-agent/biome.jsonc`（Biome 2.6.8）：`vcs.useIgnoreFile`、`files.includes` 覆盖 kernel/core/server/scripts/plugins/evals/ui，排除 `node_modules/dist/vendor/data/*@*/*.html/*.md`；formatter 2 空格 / 140 列 / lf / `javascript.formatter.quoteStyle=single`（JSX 属性双引号）；linter `preset: recommended`；两组 overrides：测试与 e2e 允许 `useYield off`、`noUnusedVariables warn`，`ui/src` 的 `useExhaustiveDependencies` 降为 warn（依赖数组是行为敏感的人工判断，逐条修会改运行时语义）。
- 修法不是"只开规则"，而是把 error 清零：`biome check .` 的 error 从 100+ 降到 **0**。过程中修掉的典型问题：`noAssignInExpressions`（`(x ??= [])` 改为显式赋值，`self-extend`、`run-service`、`ui/src/run-api.ts` 的 SSE 边界循环）、`noImplicitAnyLet`、`useIterableCallbackReturn`（`forEach(e => publish(e))` 改块体）、`noControlCharactersInRegex`、`noExportsInTest`（e2e helpers 迁到 `ui/e2e/run-fixture.ts`）、`noArrayIndexKey`、13 处 a11y、`noComponentHookFactories`（`useMaterial()`→`handleUseMaterial()`）、4 处 `noDangerouslySetInnerHtml`（核实已 `DOMPurify.sanitize` 后按理由 ignore）。
- 两个"改坏了再修好"的关键教训，已写进配置而非口头约定：① Biome 曾对 Markdown 做格式化，把 `core/skills/builtin/*/SKILL.md` 的 YAML frontmatter 打乱，导致内置技能契约测试整体失败 —— 现已 `!**/*.md` 硬排除并用 `git checkout` 还原；② 默认双引号会击穿"按文本扫描源码"的测试（`copyModule` 改写相对导入、工具块正则），现已锁 `quoteStyle: single`，同时把这两处测试改成引号无关 + 行首锚定（`/from (['"])(\.\.?\/[^'"]+)\1/g`、`^\s*kind:\s*['"]tool['"]`）。
- 接线：`package.json` 增 `lint`（`biome check .`）、`lint:fix`；`check:quality` 变为 `lint && typecheck && check:boundaries && check:coverage`；CI 在类型检查后跑 `npm run lint`。
- 实测：`biome check .` → **error 0 / warning 1492**（`noNonNullAssertion` 1287、`useTemplate` 129、`noExplicitAny` 107、`useExhaustiveDependencies` 52、`useOptionalChain` 32）。warning 不作失败条件，避免用大范围语义改动换数字。
- 代价如实交代：一次性格式化改动 **597 个文件**（含本轮 `--write` 重写 556 个），主要是换行、单引号与 140 列重排。这是 P1-1 的落地方式，也是 P2-5 表格里"行数变大"的直接原因（同一份代码在 140 列下会被折成更多行）。

### P1-2 前端测试结构失衡 —— 已修

- 新增 `ui/vitest.config.ts`（react 插件、`@`→`./src`、`define: { __APP_VERSION__ }`、jsdom、`include: src/**/*.spec.{ts,tsx}`、`setupFiles`、`restoreMocks`）与 `ui/vitest.setup.ts`（`afterEach(cleanup)`）；`ui/package.json` 增 `test` / `test:watch`。
- 首批用例 3 个文件 10 条：`ui/src/chat/tests/model.spec.ts`（4，纯逻辑）、`ui/src/tests/run-api.spec.ts`（3，SSE/运行态解析）、`ui/src/components/tests/button.spec.tsx`（3，组件渲染与变体）。
- 接线：CI 在 `ui:typecheck` 后跑 `npm --prefix ui run test`。
- 实测：`vitest run` → **3 files / 10 tests 全绿**。E2E 仍保留为跨端流程（133/133），不再承担单元职责。

### P1-3 安全关键文件覆盖率偏低 —— 已修（门禁 ≥70%）

- 新增 `web-agent/scripts/check-coverage.mjs` 与 `npm run check:coverage`，并接入 CI（`test` 之后）。口径是**逐文件**：为每个关键文件跑它自己的用例组、采一份 lcov、只看该文件的 `LF/LH`。
  - 这条口径本身是修出来的：Node 的 `--test-reporter=lcov` 跑全量并发套件时只为末班进程产出记录，`task-verifier` 单测实测 98% 会被摊薄成 23%。按目标文件分组跑，数字才是真的。
- 补测：新增 `kernel/tests/coverage-gaps.spec.ts`（11 条：JSONSchema 子集校验器的类型/枚举/const/组合子/对象/数组/字符串/数值边界、任务契约逐字段校验、`verifyTaskContract` 六类判据 + 越界路径 + schema 失败、技能锁版本语义/依赖图（缺依赖、版本不满足、环、非法名）/清单归一化/文件清单落地拒绝越界）与 `server/tests/plugin-routes.spec.ts`（9 条：能力发现、工具目录、导航两种 URL、前端模块静态托管含穿越与非法扩展名、插件列表错误→修复建议、诊断、启停/重载/卸载/未知动作/异常、配置读取、打开目录 404）。
- 实测（`npm run check:coverage`，下限 70%）：

| 文件 | 行覆盖 | 覆盖它的用例组 |
| --- | --- | --- |
| `kernel/validate.ts` | 95.43%（209/219） | coverage-gaps + tool-contract |
| `kernel/task-verifier.ts` | 98.51%（199/202） | coverage-gaps + task-verifier |
| `kernel/skillsSync.ts` | 88.86%（726/817） | coverage-gaps + skills-sync |
| `kernel/sandbox.ts` | 82.65%（162/196） | sandbox + plugin-fs-guard |
| `kernel/tool-discovery.ts` | 98.24%（334/340） | tool-discovery + tool-catalog |
| `kernel/plugin-process.ts` | 84.41%（471/558） | process-plugin |
| `kernel/plugin-loader.ts` | 81.42%（1727/2121） | loader + plugin-sdk + plugin-snapshot |
| `server/routes/plugins.ts` | 86.15%（168/195） | plugin-routes |
| `core/chat/compact.ts` | 97.45%（344/353） | compact |

- 口径更正：审查表里的 `kernel/compact.ts` 实际位于 `core/chat/compact.ts`（kernel 下不存在该文件），门禁按真实路径登记。

### P2-4 插件导入路径冲突 —— 已修

- `web-agent/README.md` 的示例统一为 `../../kernel/plugin-sdk`；内置技能 `core/skills/builtin/plugin-authoring/SKILL.md` 三处（L56 / L71 / L95）同改。
- 新增防漂移测试 `core/skills/tests/doc-plugin-examples.spec.ts`：扫描 README 与 SKILL.md 里的 ts 代码块，只允许 `kernel/plugin-sdk`，出现其他 `kernel/*` 直接失败（3/3 通过）。

### P2-5 结构热点 —— 已拆（7 个文件中 6 个落地，剩余 2 处给出明确下一步）

| 文件 | 拆分前 | 现在 | 做法 |
| --- | --- | --- | --- |
| `kernel/plugin-loader.ts` | 2322 | **2121** + `plugin-manifest.ts` 222 | 清单校验整段独立：`PLUGIN_API_VERSION`/semver/`validatePluginManifest`/`validateCapabilityIndex`/`validatePermissions`/`validateManifestLimits`/`validateManifestExecution`/`CAPABILITY_KINDS`/`assertCapabilityPermission`；loader 侧 import + re-export 保路径 |
| `server/db.ts` | 1889 | **1784** + `db-schema.ts` 119 | 行类型（`ProviderRow`/`ModelRow`/`PersonaRow`/`AuthorizationAuditRow`/`StoreKeyStatus`）、默认人设、`ConcurrentStoreWriteError`、`isHiddenMessage`、`ensureTenants` 独立，`export *` 兜住既有引用 |
| `server/services/organization/service.ts` | 2122 | **1907** + `contract.ts` 246 | 契约评分/证据/依赖/判定纯函数整段下沉（`bounded`/`evidenceOf`/`cachePrefixHash`/`unfinishedForRun`/`artifactMatches`/`taskCriteriaForContract`/`intersectTools`/`narrowProfile`/`normalizeEvaluationPolicy`/`validateSocietyDependencies`/`rootAnswer`/`DEFAULT_EVALUATION_POLICY`），service 侧 re-export 保持导出面 |
| `server/services/society/index.ts` | 1906 | **1867** + `branch-graph.ts` | 分支依赖解析与环检测 + `SOCIETY_LIST_LIMIT`（P3-9 的 1000 上限）独立 |
| `server/run-service.ts` | 1407 | **1381** + `run-types.ts` 45 | `RunError`/`RunEnvironment`/`OrganizationRunBinding` 契约独立，host 装配方只依赖契约 |
| `ui/src/App.tsx` | 1261 | **1187** + `app-shell.ts` 95 | URL 视图映射、主题/品牌持久化、模型 id、提示音、次要视图预取外移（这些函数本身是纯的；`Theme`/`Brand` 仍从 `App.tsx` re-export） |
| `ui/src/components/SettingsView.tsx` | 1643 | **1060** + `SettingsProviders.tsx` 571 + `settings-common.tsx` 34 | Provider 配置区块整体独立，共用 `Notice`/`SettingsHeading`/`EMPTY`/`PRESETS` 抽到 common |

- 验证：`typecheck` 0 错；`loader/tool-catalog/plugin-fs-guard/plugin-sdk`（47）、`run-service/society/organization/db/loader`（165）用例全绿；全量 1560 通过。
- 没做的部分与原因：`App.tsx` 仍留 1187 行 —— 剩下的体积是状态协调器本身，进一步拆需要引入 useReducer/context 的语义改动，属于单独一次重构，不在"修审查问题"的范围里；`society`/`run-service` 的类内方法仍是单类，再拆就要动调用链，已按上面拆契约与纯函数止步。
- 注意：本轮行数普遍比审查表高，是 P1-1 的 140 列格式化造成的，不是"越拆越大"；比较应按同一格式口径（拆分前同为格式化后的 2322/1889/2122/1906/1407/1261/1643）。

### P2-6 "薄内核"口径漂移 —— 已修

- 新增 `plan/adr/0006-kernel-scope.md`：给出"什么该进 kernel"的三类判据（状态机机制、跨插件契约、宿主无关的安全/执行原语）与四条排除判据（具体能力、UI/协议细节、单一插件私有逻辑、需要 core 依赖的东西），并逐条解释 `task-verifier`/`skillsSync`/`fssearch` 等 59 个文件为何仍属机制。
- `plan/adr/index.md` 收录 0006；`web-agent/README.md` 的"内核极薄"改为"内核只放机制与契约（6 状态件 + 契约件 + 跨插件机制，59 个源文件）"并链接 ADR；`web-agent/docs/ARCHITECTURE.md` 增内核判据段落。

### P2-7 文档计数与 CHANGELOG 漂移 —— 已修

- `HANDOFF.md` 的验收表加了口径说明（"以 `npm test` / `test:security` / `check:coverage` 的实际输出为准"），并把本轮实测值写回：单测 1560 通过、1 跳过、0 失败；新增"代码风格门禁 / 关键文件覆盖率 / 前端单测"三行，避免只报好数字。
- `CHANGELOG.md` 的 `## [Unreleased]` 改名为 `## 0.1.0 之后、0.2.0 之前（历史记录）`，并注明"不是待发布清单"；0.2.0 条目不动。

### P3-8 `.plugin-trial-*` 未被忽略 —— 已修

- `web-agent/.gitignore` 增 `.plugin-trial-*/`（对应 `kernel/plugin-trial.ts` 用 `mkdtemp(join(projectRoot, '.plugin-trial-'))` 建的试运行目录）。

### P3-9 两处可读性瑕疵 —— 已修

- `server/db.ts` 的 `LIKE '${SECRET_PREFIX}%'` 改为参数绑定：`.get(\`${SECRET_PREFIX}%\`, \`${PURPOSE_SECRET_PREFIX}%\`)`。
- `server/services/society` 的 9 处 `(..., 1000)` 收敛为 `SOCIETY_LIST_LIMIT = 1000`（现居 `society/branch-graph.ts`），注释明确写"这是扩展天花板，要更大规模改分页游标"；`.slice(0, 1000)` 是字符串截断，未动。

### P3-10 唯一的 dev 依赖告警 —— 已修

- `ui/package.json` 增 `overrides: { "minimatch": "^11.0.9" }`，重装后 `ui/node_modules/minimatch` 由 10.2.6 升到 **11.0.9**；验证链：`@ts-morph/common` 可加载、`shadcn --version` 输出 4.23.0（构建链路未断）。

### 修复轮顺带修掉的两个真问题（非审查条目，但会挡住 CI）

- `ui/playwright.config.ts` 的 E2E 数据目录只用 `pid` 命名，会命中前几天遗留的同名目录（里面是 v8 旧库），启动即被迁移门禁拒绝（实测本轮 E2E 在 webServer 阶段直接失败）。改为 `pid + 时间戳`。
- `ui/e2e/settings-layout.spec.ts` 的"全选"选择器与实现的可访问名（`全选会话`）不一致，导致该用例超时；选择器已对齐。

### 修复轮最终实测（CI 等价，全部本地执行）

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` / `npm --prefix ui run typecheck` | 0 错 |
| `npm test` | **1560 通过 / 1 跳过 / 0 失败**（107s） |
| `npm run test:security` | 402/402 |
| `npm run check:boundaries` | 2/2 |
| `npm run check:coverage` | **9/9 达标**（逐文件 81.42%~98.51%，下限 70%） |
| `npm run lint`（biome check） | **error 0 / warning 1492** |
| `npm --prefix ui run test` | 10/10 |
| `npm run build`（ui:typecheck + ui:build + tsc） | 通过 |
| `npm run selftest` | 90/90 |
| `npm run eval:ci` | 28/28（安全攻击阻断 100%，4/4） |
| `npm run e2e` | 133/133（单 worker，3.6 分钟） |
| `npm run check:threat-model` / `check-doc-facts` | 通过（24 个引用文件 / 6 个契约字段） |
| `npm run plugin:validate` × 2 / `plugin:lock:verify` / `skill:lock:verify` / `skill:eval` | 通过（插件锁因格式化重签，哈希已对齐）/ 通过 / 5/5 |

### 仍未做（明确边界，不掩盖）

1. `biome check` 的 1492 条 warning 没有清零：`noNonNullAssertion`（1287）在大量 `!` 断言上是既有风格，机械替换会改变类型推断与运行时行为；`useExhaustiveDependencies`（52）逐条修会改 effect 触发次数。两者都保留为可见 warning，而不是用 `--unsafe` 一把梭。
2. 真实模型 live 评测仍未跑（`eval:live`、`eval:experience:v2`、`eval:organization:live` 需要 API key 与真实成本），模型行为质量不在本轮结论内。
3. `society`/`run-service` 的类内方法未继续拆，理由见 P2-5；`App.tsx` 的进一步收敛需要状态管理重构，属独立任务。
4. CI 远端实跑未核对（只验证了本地等价命令）。

## 八、v4 架构迁移落地（2026-11-22，五期全部完成）

> 依据 `plan/architecture-v4.md` 与 ADR 0007–0011，从 0 期做到 4 期。每期结束都跑 `npm run typecheck` + `npm test`，最终跑完 CI 等价门禁。以下数字均为本机实测。

### 0 期：门禁骨架 + ADR

- `web-agent/scripts/check-complexity.mjs`：TypeScript AST 计算文件行数、最长函数行数、最大圈复杂度（分支 + `&&`/`||`/`??`）、导出数；阈值 400 / 60 / 15 / 12，基线 `plan/complexity-baseline.json` **只降不升**（新文件超标直接失败，老文件只许改善，达标自动移出）。测试文件、`tests/`、`__tests__/`、快照目录、`node_modules/dist/vendor/data/build/coverage/generated` 均排除；`--report` 打印最长函数榜，`--update-baseline` 重算。
- `web-agent/scripts/check-contracts.mjs`：`contracts/api.ts` 逐字复制到 `ui/src/generated/contracts.ts`（带"生成物请勿手改"横幅），CI 字节比对，`--write` 重新生成；源不存在时只提示不阻断（骨架期）。
- `package.json` 增 `check:complexity` / `check:contracts`；`check:quality` 扩为 `lint && typecheck && check:boundaries && check:complexity && check:contracts && check:coverage`；CI 增加分层、复杂度、契约三步。
- ADR 0007（部署信封：单机单库，三条升级触发——活动 Run>8 或写等待 p95>100ms → 单写队列；单库>5GB 或多机 → 端口换 PostgreSQL；硬多租户 → 分进程分库）、0008（run 引擎分层，只追加不重放）、0009（契约单一来源）、0010（路由只做协议，shared 拆四块）、0011（复杂度预算）；`plan/adr/index.md` 顺延登记。
- 踩坑：`biome.jsonc` 的 `files.includes` 起初不含 `contracts/**`，`biome check` 只扫到 4 个文件——已补。

### 1 期：run 引擎分层

| 新文件 | 行数 | 内容 |
| --- | --- | --- |
| `server/run/state.ts` | 26 | `statusAfterAbort` / `terminalStatus` / `statusOnEvent` 纯函数 |
| `server/run/journal.ts` | 37 | 按 run 分组的订阅表与事件广播，订阅者异常隔离 |
| `server/run/usage.ts` | 253 | `RunAccount` 增量记账、祖先传播、`ModelCallScope`（admit/start/input/finish） |
| `server/run/recovery.ts` | 143 | `recoverCheckpoint`（pending 拒绝重放、done 复用持久结果、委派给 DELEGATION_INTERRUPTED）、`resumeChildren` |
| `server/run/executor.ts` | 346 | `executeRun` 原样迁出，`ExecutorRuntime extends RecoveryRuntime` |

- `server/run-service.ts` 1381 → **719 行**：改为门面（create/start/supplement/cancel/delegate/resume/launch/权限三方法/shutdown 等），新增私有 `runtime()` 提供 `ExecutorRuntime`；对外导出面不变。
- 新测试 `run-state.spec.ts` 6 条（三状态函数全分支 + journal 分组广播/退订/抛错隔离/close）。
- 迁移中踩到并修掉的：切片重写多带一个 `}` 导致 `TS1128`；`Parameters<>` 推断把 `subscribe` 返回类型变 `string`（改回显式签名）；`Promise<void>((resolve)=>…)` 与 `path.resolve` 重名（改 `done`）。

### 2 期：路由瘦身 + usecases

- `server/routes/shared.ts`（506 行）按关注点拆到 `server/http/`：`scope.ts`(33) `sse.ts`(28) `security.ts`(314，整套 SSRF 与逐跳校验) `exec.ts`(32) `chat-service.ts`(118)；`routes/shared.ts` 变 18 行 barrel，30 个路由文件 import 路径不变。
- Provider 编排整体下沉 `server/usecases/`：`error.ts`（`UsecaseError(status, message)`）、`provider-support.ts`(225)、`providers.ts`(335)、`provider-models.ts`(119)。
- `server/routes/providers.ts` 658 → **86 行**：只剩解析、调用例、状态码映射（`UsecaseError`→状态码，`/tool-check` 502 补 `status:'unknown'`），并 re-export 诊断构建器给测试与脚本。
- 新测试 `layering.spec.ts` 3 条 AST 边界：路由不得 import `../services/*`（白名单只有 `organization.ts` 的 `isOrganizationError`）；usecases 不得 import express 或 `../../core/*`；`shared.ts` 只能是 barrel。
- 连带修正 `ssrf.spec.ts`：判定点随业务代码移动到 usecases，改为同时读 route + usecase 两份源码再断言（行为不变）。

### 3 期：契约单一来源

- `contracts/api.ts`（188 行，**零 import**）：`Session` / `ToolCallWire` / `TaskVerification` / `Message` / `ModelCapabilityInfo` / `ModelInfo` / `ProviderHealthWire` / `ProviderToolCheck` / `ProviderInfo` / `ProviderDiagnosticModel` / `ProviderDiagnostic` / `PulledModel` / `BusEvent`。
- `ui/src/types.ts` 630 → **518 行**：9 个与服务端同形的接口改为 `export type {…} from './generated/contracts'`；UI 专有类型与纯前端工具函数保留。
- 顺手消除第二处漂移：`ui/src/api.ts` 自带的窄版 `SkillInfo`（source 只有 `'builtin'|'user'`）删除，改从 `./types` 引入宽版。
- 新测试 `contracts.spec.ts` 6 条：会话/消息行可赋给 `Session[]` / `Message[]` 并逐字段断言；`listProviders` 可赋给 `ProviderInfo[]`，`apiKeyMasked === 'sk-1****7890'` 且行上无 `apiKey`；诊断模型 `vision/tools/reasoning` 是 **boolean**（正是此前前端写成 number 的漂移）；`listChatModels` 无对话服务返回 `[]`；`BusEvent` 形状；契约源无 import/require。

### 4 期：存储端口化 + 单写队列

- `server/store/write-queue.ts`：同步单写者。重入（事务内再开事务）直接执行并记深度，不自我排队；只对 `SQLITE_BUSY` / `SQLITE_LOCKED` 重试一次（事务未提交，重试安全；其它错误重试会重复副作用）；`stats()` 暴露 writes / retries / maxDepth / lastMs / totalMs / busy。
- `RunRepository.transaction` 全部经 `defaultWriteQueue`：run 事件、检查点、账本、预算预留都进同一写者，统计才有意义。
- `server/store/ports.ts`：用 `Pick<Store, …>` 按聚合根收窄出 `SessionPort` / `ProviderPort` / `ModelPort` / `RunPort` / `TenantPort` / `StorePorts`，以及 Provider 用例的扁平 `ProviderStore`——它是"这些代码被允许碰哪些表"的书面声明。
- `server/store/sqlite.ts`：identity 适配器（端口 getter 直接指向 Store，避免第二份方法转发与 `this` 丢失）；换 PostgreSQL 时实现同一 `StorePorts` 即可。
- 用例层依赖收窄：`ProviderDeps.store` 由 `Store` 变 `ProviderStore`，`readModels` / `toolCheckView` / `refreshChatProviders` 同步收窄到最小读取面（`ProviderChatSource`）。
- 新测试：`store-queue.spec.ts` 6 条（重入计一次写、BUSY 重试一次成功、非锁错误不重试、持续 BUSY 抛错后仍可继续、端口绑定与读路径、run 事务确实经过单写者）；`provider-models.spec.ts` 7 条（openai/ollama 拉取、只返回不落库、落库、参数校验、空列表、`readModels`/`updateModelProfile` 的 404/428/409）；`provider-usecases.spec.ts` 6 条（create/update/remove/test/testProvider 真实往返与 401 记失败/网关快照）。
- 复杂度基线：`run-store.ts` 因显式接线 +2 行，按有意变更刷新基线（其余只降不升）；生成物 `ui/src/generated/` 加入复杂度排除。

#### 4 期收尾续做（2026-11-22 下午，在上一版实测之后）

- **SQL 真正按聚合根搬家**（此前只做了端口声明）：新增 `server/store/sqlite/{providers,models,sessions,tenants}.ts`，把 `db.ts` 里 Provider/Model/Session/Tenant 四族 22 个方法体原样迁入，`db.ts` 只留一行委托 + 构造时装配。`SqliteProviderRepo` 构造时注入 `ProviderKeyPort`（密钥加解密留在外层），`SqliteSessionRepo implements SessionPort` 并注入 `assertIdle`。口径是"搬代码不搬语义"：所有 SQL 文本、事务边界、`Object.assign` 原地更新都逐字保留。
- **run-service 继续瘦身**：`create`（200 行）、`startSocietyAssignment`、`delegate`（160 行）抽到 `server/run/{create,society,delegate}.ts`，服务方法改一行委托；`env` / `closing` / `active` 提为 `readonly` 字段供子模块使用。`run-service.ts` 由 719 → 289 行（原 1381）。
- **rules 路由拆分**：`routes/rules-support.ts`（`RulesService` 接口、`withinPath`、`blanketAllowIn`、`policyPosture`、`atomicWrite`、`concurrentRuleWrite`、快照与历史）与 `routes/rules-policy.ts`（dry-run / history / rollback / PUT policy 四个端点）承接，`rules.ts` 由 411 → 190 行，并保留 `export {…} from './rules-support'` 兼容旧引用。
- **路由与执行器最后收口**（同日第二轮，专为"单 route ≤250 / 模块 ≤250"目标）：
  - `routes/runs.ts` 423 → **210**：plugins 授权与挂载、工作区权限档、框架隔离副本端点抽到 `run-workspace.ts`（内部再按"授权 / 插件 API / 权限档 / 框架变更"四个 ≤60 行函数分层），SSE 流抽到 `run-events.ts`，并把 `drainEvents` / `eventPayload` 与主流程分开（背压语义不变：`res.write` 返回 false 即停在当前游标）。
  - `routes/organization.ts` 418 → **202**：社会看板/建任务/裁决抽到 `organization-society.ts`（能力校验提成 `requireExplicitCapabilities`），制度/异常/团队/提案抽到 `organization-governance.ts`（四个注册器各 ≤60 行）。
  - `routes/index.ts` 356 → **241**：健康检查、就绪探针、存储容量快照连同 `ReadinessSnapshot` / `StorageSnapshot` 构建器搬到 `routes/health.ts`，`index.ts` 只保留 `export {…} from './health'` 兼容 `auth.spec.ts` 的旧引用。
  - `run/executor.ts` 361 → **248**：child 回执合并、工具解析、插件会话接管、历史裁剪、`takeMessages`、`onCheckpoint`、终态结算抽到 `run/executor-support.ts`（178 行）；`executeRun` 保留事件循环与收尾，语句顺序与事务边界未改。
  - `run/recovery.ts` 新增 `server/tests/recovery.spec.ts` 16 条：`recoverCheckpoint` 的 10 个分支（无缺失调用、pending 缺批次、边界不符、写操作缺 effectKey、副作用 pending / done 缺结果 / done 有结果复用、委派中断、读调用中断）+ `resumeChildren` 的 6 个分支（契约失效、角色停用、工作区变更、轮数耗尽、齐备重启并释放预算、父信号已 abort）。覆盖率从 34.69% 提到 **97.28%**，并重新纳入 `check:coverage`（19 项）。
- **复杂度基线的一次带账刷新**：拆出来的 `rules-policy.ts`（137 行 / 复杂度 27）、`run/create.ts`（197 / 62）、`run/delegate.ts`（166 / 26）、`run/society.ts`（122 / 24）、`store/sqlite/providers.ts`（67 / 18）是从大文件搬出的**既有**函数体，不是新写的复杂度，按"搬迁不新增"原则登记进基线（192 项），并在下节"仍未做"里点名，避免基线被当成绿灯。
- 搬迁后仍全绿（见下表），`npm test` 由 1594 增至 **1610** 通过。

#### 复杂度收口（2026-11-23）

- **`executeRun` 不再是大函数**：`run/executor.ts` 361 → **33 行**，只留编排（启动 → 循环 → 收尾）。启动装配拆到 `run/executor-start.ts`（109 行：`startExecution` / `publishRuleResolution` / `attachInstructions` / `openAccount`），循环输入与事件副作用拆到 `run/executor-flow.ts`（158 行：`buildRunnerInput` / `consumeEvent` / `shutdownRun` / `settleAborted`），结算细节仍在 `run/executor-support.ts`（243 行）。语句顺序、事务边界、事件先后逐字保留；`executeRun` 复杂度 61 → 个位数。
- **5 处"搬迁登记"逐条拆到达标**：改用真实调用点测量后逐个拆小函数——`run/create.ts` 的 `buildRecord` 66 行/16 拆成 `buildAuthorization` + `optionalRecordFields`；`run/delegate.ts` 的 `reserveBudgets` 复杂度 17 拆成 `moneyBudget` + `tokenBudget`（先判契约超限再预留，抛出顺序不变）；`run/society.ts` 的 `resolveRoute` 18 拆成 `pickProvider` / `pickModel` / `needsSync`；`routes/rules-policy.ts` 的 `handlePut` 58 行/16 拆成 `planPut`（前置校验：结构、语义、通配放行内容门、目标文件与版本乐观锁）+ `writePolicyFile`（原子写、写后回读、回滚、审计与响应）；`store/sqlite/providers.ts` 的 `upsertProvider` 18 拆成 `storedKeyFor` / `updateExisting` / 薄 `upsertProvider`。
- **基线只降不升**：`--update-baseline` 后由 192 → **186**，上述 5 个文件与 `run/executor.ts` 全部退出基线；余额 186 项是迁移前的历史热点（`core/chat/agent.ts` 等），本轮不再动。
- **覆盖率随代码搬家同步**：`check:coverage` 目标 19 → **21**，新增 `run/executor-start.ts`（99.08%）与 `run/executor-flow.ts`（100%），`run/executor.ts` 100%——拆分后逻辑仍被同一组 4 个 spec 钉住，没有"拆到覆盖盲区"。
- **`store/sqlite.ts` 的 identity 适配器保留**：`Store` 的 22 个方法已是纯委托（逐个核对过 `db.ts`），端口 getter 指向 `Store` 与指向 repo 取得的是同一对象行为；`store-queue.spec.ts` 还显式断言 `ports.runs === store.runs`。此时把 ports 改成 repo 实例只会多一层类型转换，不产生行为收益，故按"纯类型收窄 + 单一实现"保留，并在 ADR 0007 里写明换库时的替换点。

### 最终实测（CI 等价，全部本地执行，2026-11-23 收口后重跑）

| 门禁 | 结果 |
| --- | --- |
| `npm run check:quality`（lint → typecheck → boundaries → complexity → contracts → coverage） | **全链路通过** |
| `npm test` | **1610 通过 / 1 跳过 / 0 失败**（1611 用例） |
| `npm run check:coverage` | **21/21 达标**（`run/state` `run/journal` `store/write-queue` `run/executor` `run/executor-flow` 100%，`run/executor-start` 99.08%，`run/recovery` 97.28%，`http/security` 94.90%，`usecases/providers` 84.13%，`provider-models` 96.64%，`provider-support` 73.89% …） |
| `npm run check:complexity` | 通过（382 文件扫描，基线 **186** 个超标文件，新增文件零超标） |
| `npm run check:contracts` | 一致（188 行字节比对） |
| `npm run build` | 通过（ui:typecheck + ui:build + tsc） |
| `npm run e2e` | 133/133（单 worker，3.5 分钟） |
| `npm run test:security` | 402/402 |
| `npm run selftest` | 90/90 |
| `npm run eval:ci` | 28/28（安全攻击阻断 4/4） |
| `npm --prefix ui run test` | 10/10 |
| `node scripts/check-doc-facts.mjs` / `check:threat-model` | 通过（6 个契约字段 / 24 个引用文件 / 11 个安全 spec） |
| `plugin:validate` ×2 / `plugin:lock:verify` / `skill:lock:verify` | 通过 |

### 收口复验：旧目标已达成

「单 route ≤250 行」：`rules.ts` 190、`providers.ts` 86、`shared.ts` 18、`runs.ts` 210、`organization.ts` 202、`index.ts` 241、`health.ts` 142、`rules-policy.ts` 246；新模块 `run-workspace.ts`、`run-events.ts`、`organization-society.ts`、`organization-governance.ts` 均在 250 行以内，且注册器函数再按 ≤60 行分层。「run 模块 ≤250 行」：`executor.ts` 33 + `executor-start.ts` 109 + `executor-flow.ts` 158 + `executor-support.ts` 243、`recovery.ts` 147。「recovery 覆盖率 ≥70%」：97.28%（16 条分支用例）。「复杂度预算」：5 处搬迁登记与 `executeRun` 全部达标退出基线（192 → 186）。

### 仍未做（明确边界）

1. 基线余额 186 项是迁移前就存在的热点（`core/chat/agent.ts` 1609 行/334、`ui/src/components/WorkbenchView.tsx`、`core/mcp/index.ts`、`core/tools-fs/index.ts` 等），属后续独立轮次，不在 v4 架构迁移范围内。
2. `check:coverage` 的 21 个目标之外，`server/store/ports.ts` 为纯类型文件（无运行时行）、`contracts/api.ts` 由 `contracts.spec.ts` + 字节门禁共同守护，未设行覆盖下限。
3. 1495 条 lint warning 依旧保留可见（策略同上一轮：不用 `--unsafe` 一把梭）。
4. CI 远端实跑未核对；本轮只验证了本地等价命令。
5. `server/store/sqlite.ts` 仍保留 identity 适配器——理由见上节，非遗漏；换 PostgreSQL 时的替换点已写在 ADR 0007。

