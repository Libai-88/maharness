/**
 * server/routes/rules.ts —— 用户规则管理（读写全局/项目规则文件与策略规则）
 * 安全：只在「data/rules 目录」「工作区内候选文件」「rules.json」三类路径内读写，
 *      路径必须落在允许目录内（防任意写），写入走原子替换。
 *
 * A6-3 收口（策略注入旁路审批门）：
 *  · 变更类方法（PUT）本身受 `x-maharness-token` 门管辖（见 server/index.ts）；
 *  · 另加一层与 token 无关的内容门：**通配 allow**（tool 为 `*`/`**`/`?*` 这类纯通配、
 *    effect 为 allow）等于一次性关掉整个审批机制，是这条旁路的教科书形态
 *    （`{tool:"*",effect:"allow"}` 一条即成）。经 HTTP 写入必须显式确认：
 *    请求体带 `confirm:true`，或环境变量 MAHARNESS_ALLOW_BLANKET_ALLOW=1；
 *    否则 400 + 中文说明（想放行具体工具请写工具名/glob，别用纯通配）。
 *  · 直接编辑 data/rules.json 文件仍然可行——那是文件权限层面的既有事实（本机同权限进程
 *    本就能写它），本门只保证「一次无意的 HTTP 调用」关不掉审批。
 *  · 状态可见：已生效的通配 allow 由 GET /api/security 如实报出（policy.blanketAllow），
 *    前端能显示「当前审批门已被策略整体放行」而不是靠 401/无审批反推。
 */
import type { Express } from 'express';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getChatService, type RouteDeps } from './shared';
import { registerPolicyRoutes } from './rules-policy';
import { atomicWrite, concurrentRuleWrite, withinPath } from './rules-support';
import { isBlanketAllow, isWildcardTool, personaRuleDescriptor, resolveRuleDescriptors, runtimeRuleDescriptor } from '../../kernel/rules';
import type { PolicyRule } from '../../kernel/rules';
import { fileRevisionSync } from '../../kernel/atomic-file';

interface RulesService {
  sources: () => { scope: 'global' | 'project'; file: string; exists: boolean; chars: number }[];
  resolution?: () => import('../../kernel/types').RuleResolution;
  policy: () => PolicyRule[];
  errors: () => string[];
  reload: () => boolean;
  paths: () => { globalDir: string; globalPolicy: string; projectRoot: string };
  promptBlock?: () => string;
}

const SAFE_NAME = /^[\w.\u4e00-\u9fa5-]{1,64}\.md$/;

export { isBlanketAllow, isWildcardTool };

export {
  blanketAllowIn,
  policyPosture,
  atomicWrite,
  concurrentRuleWrite,
  listPolicyHistory,
  policyHistoryDir,
  snapshotPolicy,
} from './rules-support';

export function registerRulesRoutes(app: Express, deps: RouteDeps): void {
  const { kernel } = deps;
  const svc = (): RulesService | undefined => kernel.plugins.resolveService('service:rules') as RulesService | undefined;

  const within = withinPath;

  app.get('/api/rules', (_req, res) => {
    const s = svc();
    if (!s) return res.status(503).json({ error: 'rules 插件未加载' });
    const p = s.paths();
    const globalNames = existsSync(p.globalDir) ? readdirSync(p.globalDir).filter((f) => f.endsWith('.md')) : [];
    const globalFiles = globalNames.map((f) => ({
      name: f,
      content: (() => {
        try {
          return readFileSync(join(p.globalDir, f), 'utf-8');
        } catch {
          return '';
        }
      })(),
      revision: fileRevisionSync(join(p.globalDir, f)),
    }));
    const projectFiles = s
      .sources()
      .filter((x) => x.scope === 'project' && x.exists)
      .map((x) => ({
        name: x.file,
        content: (() => {
          try {
            return readFileSync(x.file, 'utf-8');
          } catch {
            return '';
          }
        })(),
        revision: fileRevisionSync(x.file),
      }));
    res.json({
      paths: p,
      policy: s.policy(),
      policyRevisions: {
        global: fileRevisionSync(p.globalPolicy),
        project: fileRevisionSync(join(p.projectRoot, '.maharness', 'rules.json')),
      },
      ruleFileRevisions: {
        global: Object.fromEntries(
          [...globalNames, 'maharness.md', 'new-rule.md'].map((name) => [name, fileRevisionSync(join(p.globalDir, name))]),
        ),
        project: Object.fromEntries(
          ['AGENTS.md', 'CLAUDE.md', '.claude/CLAUDE.md', '.agents/AGENTS.md'].map((name) => [
            name,
            fileRevisionSync(join(p.projectRoot, name)),
          ]),
        ),
      },
      policyFiles: [p.globalPolicy, join(p.projectRoot, '.maharness', 'rules.json')].filter((f) => existsSync(f)),
      errors: s.errors(),
      globalFiles,
      projectFiles,
      promptChars: s.promptBlock?.().length ?? 0,
    });
  });

  app.get('/api/rules/effective', (_req, res) => {
    const s = svc();
    const resolved = s?.resolution?.();
    const contextRules = (getChatService(kernel)?.getUserContext?.() ?? []).map(personaRuleDescriptor);
    const effective = resolveRuleDescriptors([runtimeRuleDescriptor(), ...contextRules, ...(resolved?.applied ?? [])]);
    res.json({
      schemaVersion: 1,
      precedence: [
        'runtime',
        'current-user-instruction',
        'confirmed-project-or-user-rules',
        'skill-and-plugin-guidance',
        'examples-and-style',
      ],
      applied: effective.applied,
      ignored: [
        ...(resolved?.ignored ?? []),
        ...effective.ignored.filter((rule) => !(resolved?.ignored ?? []).some((item) => item.id === rule.id)),
      ],
      conflicts: [...(resolved?.conflicts ?? []), ...effective.conflicts],
      policy: s?.policy() ?? [],
      errors: s?.errors() ?? [],
    });
  });

  // 写全局规则文件（data/rules/<name>.md）
  app.put('/api/rules/global/:name', (req, res) => {
    const s = svc();
    if (!s) return res.status(503).json({ error: 'rules 插件未加载' });
    const name = String(req.params.name);
    if (!SAFE_NAME.test(name)) return res.status(400).json({ error: '文件名只能是 中文/字母/数字/._- 且以 .md 结尾' });
    const content = String(req.body?.content ?? '');
    if (content.length > 200_000) return res.status(400).json({ error: '单文件超过 200k 字符' });
    const file = join(s.paths().globalDir, name);
    if (!within(file, s.paths().globalDir)) return res.status(400).json({ error: '路径越界' });
    const revision = typeof req.body?.revision === 'string' ? req.body.revision : undefined;
    if (!revision) return res.status(428).json({ error: '保存规则前须携带读取到的文件版本' });
    if (revision !== fileRevisionSync(file)) return res.status(409).json({ error: '规则文件已被其他写入者修改，请重新读取后再保存' });
    try {
      atomicWrite(file, content, revision);
    } catch (error) {
      if (concurrentRuleWrite(res, error)) return;
      throw error;
    }
    s.reload();
    res.json({ ok: true, file, revision: fileRevisionSync(file) });
  });

  // 写项目规则文件（只允许 AGENTS.md / CLAUDE.md / .maharness/rules/*.md）
  app.put('/api/rules/project', (req, res) => {
    const s = svc();
    if (!s) return res.status(503).json({ error: 'rules 插件未加载' });
    const root = s.paths().projectRoot;
    const rel = String(req.body?.path ?? 'AGENTS.md').replace(/\\/g, '/');
    const allowed = ['AGENTS.md', 'CLAUDE.md', '.claude/CLAUDE.md', '.agents/AGENTS.md'];
    const ok = allowed.includes(rel) || (rel.startsWith('.maharness/rules/') && SAFE_NAME.test(rel.split('/').pop() ?? ''));
    if (!ok) return res.status(400).json({ error: `只允许写入 ${allowed.join(' / ')} 或 .maharness/rules/*.md` });
    const file = join(root, rel);
    if (!within(file, root)) return res.status(400).json({ error: '路径越界' });
    const content = String(req.body?.content ?? '');
    if (content.length > 200_000) return res.status(400).json({ error: '单文件超过 200k 字符' });
    const revision = typeof req.body?.revision === 'string' ? req.body.revision : undefined;
    if (!revision) return res.status(428).json({ error: '保存规则前须携带读取到的文件版本' });
    if (revision !== fileRevisionSync(file)) return res.status(409).json({ error: '规则文件已被其他写入者修改，请重新读取后再保存' });
    try {
      atomicWrite(file, content, revision);
    } catch (error) {
      if (concurrentRuleWrite(res, error)) return;
      throw error;
    }
    s.reload();
    res.json({ ok: true, file: rel, revision: fileRevisionSync(file) });
  });

  // 策略规则：整表写入（scope=global → data/rules.json；project → <workspace>/.maharness/rules.json）
  registerPolicyRoutes(app, deps, svc);
}
