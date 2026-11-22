/** server/routes/rules-support.ts —— 规则路由的路径/历史/策略姿态工具（从 rules.ts 拆出） */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { atomicWriteFileSync, ConcurrentWriteError } from '../../kernel/atomic-file';
import { isBlanketAllow, loadPolicyRules } from '../../kernel/rules';
import type { RouteDeps } from './shared';

/** rules 插件（service:rules）暴露的读取面 */
export interface RulesService {
  sources: () => { scope: 'global' | 'project'; file: string; exists: boolean; chars: number }[];
  resolution?: () => import('../../kernel/types').RuleResolution;
  policy: () => import('../../kernel/rules').PolicyRule[];
  errors: () => string[];
  reload: () => boolean;
  paths: () => { globalDir: string; globalPolicy: string; projectRoot: string };
  promptBlock?: () => string;
}

export const POLICY_HISTORY_LIMIT = 20;
export const SAFE_HISTORY_NAME = /^[a-z]+-[\w.-]+\.json$/;

/** 统一的大小写无关路径包含判定（Windows/Linux 同口径） */
export function withinPath(file: string, root: string): boolean {
  const r = resolve(root).toLowerCase();
  const f = resolve(file).toLowerCase();
  return f === r || f.startsWith(r + '\\') || f.startsWith(r + '/');
}

/** 已生效策略里的通配 allow 明细（/api/security 用；文件不存在/解析失败都按空处理） */
export function blanketAllowIn(files: string[]): { file: string; tool: string; id: string }[] {
  const out: { file: string; tool: string; id: string }[] = [];
  for (const f of files) {
    try {
      if (!existsSync(f)) continue;
      for (const r of loadPolicyRules([f]).rules) {
        if (isBlanketAllow(r)) out.push({ file: f, tool: r.tool, id: r.id });
      }
    } catch {
      /* 状态接口绝不因规则文件问题而 500 */
    }
  }
  return out;
}

/** GET /api/security 用的策略姿态：插件未加载时如实说不知道，不把「取不到」报成「没风险」 */
export function policyPosture(kernel: RouteDeps['kernel']): {
  available: boolean;
  files: string[];
  blanketAllow: { file: string; tool: string; id: string }[];
} {
  const s = kernel.plugins.resolveService('service:rules') as RulesService | undefined;
  if (!s) return { available: false, files: [], blanketAllow: [] };
  try {
    const p = s.paths();
    const files = [p.globalPolicy, join(p.projectRoot, '.maharness', 'rules.json')].filter((f) => existsSync(f));
    return { available: true, files, blanketAllow: blanketAllowIn(files) };
  } catch {
    return { available: false, files: [], blanketAllow: [] };
  }
}

export function atomicWrite(file: string, content: string, expectedRevision?: string): void {
  atomicWriteFileSync(file, content, { expectedRevision });
}

export function concurrentRuleWrite(res: { status: (code: number) => { json: (body: unknown) => unknown } }, error: unknown): boolean {
  if (!(error instanceof ConcurrentWriteError)) return false;
  res.status(409).json({ error: '规则文件已被其他写入者修改，请重新读取后再保存' });
  return true;
}

export function policyHistoryDir(dataDir: string): string {
  return join(dataDir, 'rules-policy-history');
}

/** 写入前保存上一版策略；只保留最近 N 份，失败不阻断正式写入（回滚是增强，不是写入前置条件）。 */
export function snapshotPolicy(file: string, scope: 'global' | 'project', dataDir: string): string | null {
  try {
    if (!existsSync(file)) return null;
    const dir = policyHistoryDir(dataDir);
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `${scope}-${stamp}-${randomUUID().slice(0, 8)}.json`;
    writeFileSync(join(dir, name), readFileSync(file, 'utf-8'), 'utf-8');
    const entries = readdirSync(dir)
      .filter((item) => item.startsWith(`${scope}-`) && item.endsWith('.json'))
      .sort()
      .reverse();
    for (const stale of entries.slice(POLICY_HISTORY_LIMIT)) {
      try {
        unlinkSync(join(dir, stale));
      } catch {
        /* 历史清理失败不影响主写入 */
      }
    }
    return name;
  } catch {
    return null;
  }
}

export function listPolicyHistory(
  dataDir: string,
  scope?: 'global' | 'project',
): { name: string; scope: 'global' | 'project'; createdAt: number; bytes: number }[] {
  const dir = policyHistoryDir(dataDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => SAFE_HISTORY_NAME.test(name) && (!scope || name.startsWith(`${scope}-`)))
    .map((name) => {
      const full = join(dir, name);
      const stat = statSync(full);
      return {
        name,
        scope: name.split('-')[0] as 'global' | 'project',
        createdAt: stat.mtimeMs,
        bytes: stat.size,
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, POLICY_HISTORY_LIMIT);
}
