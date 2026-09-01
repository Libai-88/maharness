# 学术智能体 —— maharness × ARS 融合设计

> 版本：v1.0（2026-09-01）
> 上游：[Academic Research Skills (ARS)](https://github.com/Imbad0202/academic-research-skills) v3.21.1（CC BY-NC 4.0，作者 Cheng-I Wu）
> 原则：**ARS 是成熟技能套件，内容零改动；maharness 朝 ARS 的工作流适配。**

## 1. ARS 是什么、maharness 接住了什么

ARS 是一套 Claude Code 技能（4 个技能、27 种模式、30+ 子代理角色定义、100+ 参考文献/模板），覆盖科研全流程：

| 技能 | 角色 | 模式示例 |
| --- | --- | --- |
| `deep-research` | 13 员研究团队 | full / quick / lit-review / systematic-review / fact-check / three-way-scan / socratic |
| `academic-paper` | 12 员写作管线 | full / plan / outline / revision / revision-coach / citation-check / format-convert / disclosure |
| `academic-paper-reviewer` | 5 席评审团 | full / re-review / quick / methodology-focus / calibration |
| `academic-pipeline` | 10 阶段编排器 | 研究→写作→完整性核查(2.5)→评审→修改→复审(4')→终核查(4.5)→定稿 |

**融合方式：整体 vendor，不做摘编。** 4 个 SKILL.md 之间存在大量相对仓库根的跨目录引用（`shared/`×89、`scripts/`×172、`docs/design`×56、`.claude/`×8，另有技能内 `agents/ references/ templates/ examples/`），抽单文件必然断链。因此上游仓库原样落位 `web-agent/vendor/academic-research-skills/`（剔除 `.git .github evals tests audits tools pi` 七个运行时无关的仓库基建目录，其余逐字节一致——已用 diff 全量校验零修改）。许可与署名文件（LICENSE / NOTICE / CITATION.cff）随包保留。

## 2. maharness 侧适配清单（本次全部改动）

| # | 改动 | 文件 | 为什么 |
| --- | --- | --- | --- |
| 1 | **vendor ARS 技能包** | `vendor/academic-research-skills/` | 上游内容零修改的物理前提；放在 `data/` 之外以避开沙箱读保护 |
| 2 | **技能系统 pack 来源** | `core/skills/index.ts` | 第三扫描根 `vendor/<pack>/<name>/SKILL.md`，`list_skills`/`get_skill` 原生可见（source=`pack`） |
| 3 | **`get_skill_file` 工具** | `core/skills/index.ts` | ARS 的多文件资源契约：`agents/*.md`（子代理定义）、`references/`、`templates/` 按技能根解析；`shared/ scripts/ docs/ .claude/` 自动回退到技能包根解析。路径防穿越（`..`/绝对路径/盘符拒绝），单文件 20 万字符截断显式告知 |
| 4 | **学术路由 persona** | `core/academic/index.ts`（新插件） | 触发词→技能映射（等价 ARS SKILL.md 的 Trigger Keywords，且补了简体中文场景约定）；资源读取契约；ARS agent 团队→maharness 编排工具的映射；人机协作纪律 |
| 5 | **`run_subagent` maxTurns 参数** | `core/subagent/index.ts` | ARS 的检索席位/评审席位普遍超过默认 6 轮；参数钳制 1-12 防失控 |
| 6 | **classifyTask 学术关键词** | `kernel/budget.ts` | 文献/综述/查新→检索、论文/投稿/摘要/审稿→写作，`agent.modelRouting` 可按类目配模型路由 |
| 7 | **pack 读取路由** | `server/routes/skills.ts` | `GET /api/skills/pack/:name/read` 网页端可查看技能全文 |
| 8 | **UI 技能包分组** | `ui/src/types.ts`、`SkillsView.tsx`、`SkillsPanel.tsx` | 「已安装 · 技能包（ARS 学术）」分组 + 标签；卸载按钮仍仅限用户技能 |
| 9 | **.gitignore 例外** | `maharness/.gitignore` | 全局 `.claude/` 忽略规则会误伤 vendor 内 ARS 的路由纪律文件（`.claude/CLAUDE.md`，4 个 SKILL.md 均引用），加 `!web-agent/vendor/**/.claude/` 例外 |

内核（kernel/）零改动——又一次验证「薄内核 + 全插件化」：学术化改造全部发生在能力层。

## 3. 运行时工作流（一次学术任务怎么跑）

```
用户："帮我做 XX 课题的文献综述"
  → persona(ars-routing) 命中路由 → get_skill("deep-research") 读全文
  → 按 SKILL.md 选择模式（lit-review），逐个 get_skill_file(skill, "agents/xxx_agent.md")
  → run_subagent(objective=按角色定义构造, maxTurns=8~12) 派发研究席位
      （互不依赖的检索支线 → run_parallel；快速自查 → run_review）
  → 阶段产物 write_file 写入工作区 → 停下等用户确认 → 下一阶段
  → 完整性核查（pipeline 2.5/4.5）：powershell_execute 运行
      python vendor/academic-research-skills/scripts/verify_passport.py
      （无 Python 时如实声明降级，绝不假装已核查）
```

对应 ARS 的三大工作流假设在 maharness 的落点：

| ARS 假设（Claude Code） | maharness 落点 |
| --- | --- |
| SKILL.md 按触发词激活 | persona 路由表（priority 25，system prompt L2 层） |
| 子代理（Task + agents/*.md） | `run_subagent`（独立上下文 + span 树 + 配额）+ `run_parallel` + `run_review` |
| Bash 跑 scripts/ 校验脚本 | `powershell_execute`（cwd 锚定沙箱根，非白名单命令走审批） |
| 阶段确认检查点（human-in-the-loop） | 对话轮次本身——agent 必须停下等确认，harness 不代答 |
| slash commands（ars-*） | 自然语言即触发；命令面板不承载技能激活 |

## 4. 可选依赖（缺省全部可降级）

| 依赖 | 用途 | 缺失时 |
| --- | --- | --- |
| Python 3 | ARS 确定性校验脚本（引用存在性 gate、passport 校验等） | 脚本步骤如实标记未执行，LLM 侧检查照常 |
| Pandoc / tectonic | DOCX / APA7 PDF 导出 | Markdown 产物照常（ARS 官方口径） |
| `TAVILY_API_KEY` | 文献检索升级（DuckDuckGo 降级可用） | DDG 兜底 |
| MCP servers | 可再接 arXiv / Zotero 等学术数据源（`config.json` 的 `mcp.servers`，零代码接入） | 不影响技能流 |

成本治理照常生效：模型路由（学术关键词已入 classifyTask）、子代理配额、会话成本熔断、三层缓存——文献检索类任务建议在 `config.json` 的 `agent.modelRouting` 给「检索」「写作」配性价比模型。

## 5. 验证记录（2026-09-01）

- `npm run typecheck` 0 error；`ui: build` 通过；`npm test` 80/80。
- 服务端冒烟：`/api/plugins` 可见 `academic(started)` 与 `skills`（3 工具）；`/api/skills` 列出 5 内置 + 4 技能包；`GET /api/skills/pack/deep-research/read` 返回 36.6KB 全文。
- `get_skill_file` 运行时 7 例：技能根相对（52.7KB）、包根回退（`shared/` 11KB、`.claude/` 67KB）、`scripts/*.py` 可读、`..` 穿越拒绝、绝对路径拒绝、service 层 get/list 正常。
- 上游保真：`diff -rq` vendor vs 上游克隆 → 保留文件零差异（仅缺 7 个有意剔除的基建目录）。

## 6. 已知边界

- ARS 面向 Claude Code 的部分机制（PreToolUse 写保护 hook、16 个 slash 命令、plugin 更新检查）在 maharness 不生效也不需要——前者由 maharness 自身的审批/沙箱/内核写保护承担，后者由 persona 路由与命令面板替代。
- ARS 的跨模型验证（`ARS_CROSS_MODEL`）依赖额外 provider 配置，maharness 的多 provider/failover 可作为其承载，尚未接线（后续可把 cross-model 审查映射为指定 provider 的 run_subagent）。
- 技能包升级 = 替换 `vendor/academic-research-skills/` 目录后重启（vendor 不在热加载监听范围，避免大目录 watch 开销）。
