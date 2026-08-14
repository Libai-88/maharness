---
name: skill-authoring
description: 如何编写一个 maharness skill。需要给 Agent 增加可复用的能力指南/知识包时使用（含格式规范、质量要求、使用场景）。
---

# Skill 编写指南

## 什么是 skill
skill 是给 Agent 的可复用能力指南：一个目录 + 一份 `SKILL.md`（带 frontmatter）。它不是代码插件，而是"知识包"——Agent 在需要时通过 `list_skills` / `get_skill` 按需读取。适合：重复性任务流程、领域知识、自我改造规范。

## 何时创建 skill
- 用户反复做同一类任务（如"写周报""代码审查"）；
- 需要特定领域知识才能做好（如 Windows 批处理规范）；
- 你（Agent）发现自己重复犯同类错误——写一条 skill 固化修正规则；
- 自我改造前先看 `agent-self-design`，写插件前先看 `plugin-authoring`。

## 格式规范
```
skill-name/
└── SKILL.md
```
SKILL.md：
```markdown
---
name: skill-name            # 小写连字符，与目录同名
description: 一句话描述触发场景（Agent 据此判断何时读取）
---

正文：给 Agent 的可执行指导，含步骤、规则、示例。
```

## 质量要求
1. **description 精确**：写清"何时用"，宁可具体不可宽泛；
2. **正文可执行**：步骤化、给示例，避免空泛原则；
3. **小而专注**：一个 skill 只解决一个问题，正文控制在 3000 字符内（超出会被截断）；
4. **可验证**：包含自查清单或验收点。

## 安装与分发
- 放入 `market/` 目录（web 端「设置 → Skills」一键安装）；
- 已安装的存于 `data/skills/`，随插件热加载即时可用。
