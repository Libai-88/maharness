# 供应链审计与升级策略 v1

适用对象：npm 依赖、技能包、插件。三类对象的共同要求：来源可追溯、字节可校验、升级路径明确、回滚步骤可执行。策略与实现不一致时以修复实现或修订本文对齐。

## npm 依赖

| 项 | 要求 | 证据 |
|---|---|---|
| 版本锚定 | `web-agent/package-lock.json` 与 `web-agent/ui/package-lock.json`（lockfileVersion 3）精确锚定全部依赖 | `npm ci` 按锁文件安装，任何 lockfile 漂移在 CI 缓存键与本地 `npm ci` 中暴露 |
| 安装方式 | `npm ci` 为唯一受支持方式，禁止以 `npm install` 日常替换 | `DEVELOPMENT.md` 明确；CI 步骤即 `npm ci` |
| 漏洞审计 | 发布前跑 `npm audit --omit=dev --registry=https://registry.npmjs.org`（后端与 `--prefix ui`），要求 0 漏洞 | 2026-11-01 双仓 0 漏洞；本轮 `npm audit fix` 清零 body-parser/proxy-addr/qs/undici/DOMPurify |
| 升级路径 | 漏洞修复：`npm audit fix --registry=https://registry.npmjs.org` → 确认 lockfile diff 只含漏洞修复范围 → 全量回归 → 提交锁文件；版本升级：`npm install <pkg>@<ver>` 逐个进行，不做无锁批量升级 | 本轮 5 项修复均经 `npm test` 911/911、`selftest` 91/91、`build` 验证 |
| 回滚路径 | `git checkout <上一提交> -- web-agent/package-lock.json web-agent/ui/package-lock.json` 后重新 `npm ci` | lockfile 是唯一真相源，回滚即还原文件 |

## 技能包（skills-lock.json）

| 项 | 要求 | 证据 |
|---|---|---|
| 来源锚定 | 每条目记录 `source`（owner/repo）、`sourceType`、`skillPath` | `kernel/skillsSync.ts` 锁文件格式 |
| 字节校验 | `computedHash`（SKILL.md sha256）为历史锚点；`files` 逐文件哈希清单覆盖全部文件时清单外文件拒绝落盘 | `skillsSync.ts` A9 收口：临时目录校验 → 原子换入，失败不留半成品 |
| 校验不可跳过 | `force` 语义为覆盖已安装，不跳过完整性校验；哈希不符即失败并回报实际哈希 | 接受上游变更须改锁文件或显式 `MAHARNESS_ALLOW_SKILL_HASH_MISMATCH=1` |
| 升级路径 | 上游变更 → 更新锁文件哈希（或逐文件清单）→ `POST /api/skills/sync` → 校验结果确认 computed/mismatch 字段 | `/api/skills/lock` 返回 computedHash 与逐文件状态 |
| 回滚路径 | 还原锁文件旧哈希后重新 sync；换入前旧目录整体让位，无混合状态 | 原子 rename 语义 |

## 插件

| 项 | 要求 | 证据 |
|---|---|---|
| 内容完整性 | 插件目录加载前取内容聚合哈希，镜像到 `<name>@<hash>` 快照目录，入口从快照加载 | `kernel/plugin-snapshot.ts`；内容一变即换目录名 |
| 版本兼容 | manifest 声明 `compatibility.api` 范围，加载前校验，越界拒绝 | `plugin-loader.ts` `validateManifestCompatibility` |
| 能力白名单 | `permissions.capabilities` 声明允许登记的能力；未声明走本机 trusted 兼容模式 | `ctx.register` 拒绝未声明登记并发布 `plugin.permission.denied` |
| 前端模块 | `nav.mode='module'` 的 URL 携带内容哈希（`?v=<digest>`），UI 改动即时生效且无缓存漂移 | `plugin-loader.ts` `moduleUrlOf` + 服务端 `Cache-Control: no-store` |
| 升级路径 | 文件变更 → 内容哈希变化 → 新快照目录自动生效；manifest 不兼容时加载失败并给出诊断 | 插件诊断面板 `/api/plugins/diagnostics` |
| 回滚路径 | 恢复旧版本文件（内容哈希回到旧快照目录名）或停用插件（卸载即完全恢复） | 快照目录内容寻址，旧快照保留 |
