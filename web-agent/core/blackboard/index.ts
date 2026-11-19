/**
 * core/blackboard/index.ts —— 会话级共享黑板
 *
 * 主代理、子代理和并行任务共享结构化中间结果，但绝不共享完整上下文。
 * 数据按 sessionId 隔离，落盘 data/blackboard.json（原子写 + LRU）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Plugin, ToolContext } from '../../kernel/plugin-sdk';

interface Entry {
  value: unknown;
  tags?: string[];
  updatedAt: number;
}

type Board = Record<string, Entry>;
type Data = Record<string, Board>;

const MAX_SESSIONS = 50;
const MAX_ENTRIES = 200;
const MAX_VALUE_CHARS = 20_000;

export interface BlackboardEntry {
  value: unknown;
  tags?: string[];
  updatedAt: number;
}

export interface BlackboardService {
  put(sessionId: string, key: string, value: unknown, tags?: string[], tenantId?: string): { key: string; bytes: number; updatedAt: number };
  get(sessionId: string, key: string, tenantId?: string): BlackboardEntry | undefined;
  list(sessionId: string, prefix?: string, tenantId?: string): { key: string; tags?: string[]; updatedAt: number }[];
  delete(sessionId: string, key: string, tenantId?: string): boolean;
}

/** 租户 + 会话联合作用域；旧数据没有租户前缀时按 default 迁移。 */
function scopeKey(tenantId: string | undefined, sessionId: string | undefined): string {
  return `${String(tenantId || 'default')}\u0000${String(sessionId || '_default')}`;
}

function load(file: string): Data {
  try {
    if (!existsSync(file)) return {};
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Data = {};
    for (const [sessionId, board] of Object.entries(raw as Record<string, unknown>)) {
      if (!board || typeof board !== 'object' || Array.isArray(board)) continue;
      const normalized: Board = Object.create(null) as Board;
      for (const [key, entry] of Object.entries(board as Record<string, unknown>)) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const item = entry as Record<string, unknown>;
        if (typeof item.updatedAt !== 'number') continue;
        normalized[key] = {
          value: item.value,
          ...(Array.isArray(item.tags) ? { tags: item.tags.filter((tag): tag is string => typeof tag === 'string') } : {}),
          updatedAt: item.updatedAt,
        };
      }
      out[sessionId] = normalized;
    }
    const migrated: Data = {};
    for (const [key, board] of Object.entries(out)) {
      migrated[key.includes('\u0000') ? key : `default\u0000${key}`] = board;
    }
    return migrated;
  } catch {
    return {};
  }
}

function save(file: string, data: Data): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmp, file);
  } catch {
    /* 持久化失败不阻断对话 */
  }
}

function trimBoard(board: Board): void {
  const entries = Object.entries(board).sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  for (const [key] of entries.slice(0, Math.max(0, entries.length - MAX_ENTRIES))) delete board[key];
}

export default {
  id: 'blackboard',
  name: '共享黑板',
  version: '0.1.0',
  onLoad(ctx) {
    const file = join(ctx.paths.data, 'blackboard.json');
    const data = load(file);
    const getBoard = (sessionId: string, tenantId?: string): Board => {
      const key = scopeKey(tenantId, sessionId);
      if (!data[key]) data[key] = Object.create(null) as Board;
      return data[key]!;
    };
    const persist = () => save(file, data);

    const service: BlackboardService = {
      put(sessionId, key, value, tags, tenantId) {
        const normalizedKey = String(key ?? '').trim();
        if (!normalizedKey) throw new Error('缺少 key');
        if (normalizedKey === '__proto__' || normalizedKey === 'constructor' || normalizedKey === 'prototype') {
          throw new Error('key 不能使用保留字');
        }
        const serialized = JSON.stringify(value);
        if (serialized === undefined) throw new Error('value 必须是可序列化的 JSON 值');
        if (serialized.length > MAX_VALUE_CHARS) throw new Error(`value 过长（${serialized.length} > ${MAX_VALUE_CHARS} 字符）`);
        const board = getBoard(sessionId, tenantId);
        board[normalizedKey] = {
          value,
          ...(Array.isArray(tags) ? { tags: tags.filter((tag): tag is string => typeof tag === 'string') } : {}),
          updatedAt: Date.now(),
        };
        trimBoard(board);
        if (Object.keys(data).length > MAX_SESSIONS) {
          const oldest = Object.entries(data).sort((a, b) => {
            const latest = (candidate: Board) => Math.max(0, ...Object.values(candidate).map((entry) => entry.updatedAt));
            return latest(a[1]) - latest(b[1]);
          })[0]?.[0];
          if (oldest) delete data[oldest];
        }
        persist();
        return { key: normalizedKey, bytes: serialized.length, updatedAt: board[normalizedKey]!.updatedAt };
      },
      get(sessionId, key, tenantId) {
        return getBoard(sessionId, tenantId)[String(key ?? '')];
      },
      list(sessionId, prefix = '', tenantId) {
        return Object.entries(getBoard(sessionId, tenantId))
          .filter(([key]) => !prefix || key.startsWith(prefix))
          .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
          .slice(0, 50)
          .map(([key, entry]) => ({ key, tags: entry.tags, updatedAt: entry.updatedAt }));
      },
      delete(sessionId, key, tenantId) {
        const board = getBoard(sessionId, tenantId);
        if (!(String(key ?? '') in board)) return false;
        delete board[String(key ?? '')];
        persist();
        return true;
      },
    };

    ctx.register({ kind: 'service', service: { id: 'blackboard', instance: service } });

    ctx.register({
      kind: 'persona',
      persona: {
        id: 'blackboard-rules',
        name: '共享黑板使用规则',
        description: '约束多代理共享结构化中间结果',
        priority: 7,
        content: [
          '共享黑板使用规则：',
          '需要复用的中间结果用 blackboard_put / blackboard_get 共享；只放结构化结论、证据或路径，不放密钥或大段原文。',
        ].join('\n'),
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        version: '2.0.0',
        permissions: ["workspace.read","workspace.write"],
        name: 'blackboard_put',
        risk: 'low',
        costHint: 'low',
        sideEffect: 'write',
        outputSchema: {
          type: 'object', required: ['key', 'bytes', 'updatedAt'],
          properties: { key: { type: 'string' }, bytes: { type: 'integer' }, updatedAt: { type: 'integer' } },
        },
        limits: `会话级；单值 ≤ ${MAX_VALUE_CHARS} 字符；每会话最多 ${MAX_ENTRIES} 条`,
        description: '写入会话共享黑板（覆盖同名 key）。用于主代理/子代理/并行任务共享结构化中间结果。',
        parameters: {
          type: 'object',
          properties: {
            key: { type: 'string', minLength: 1, maxLength: 80 },
            value: { description: '任意 JSON 值（结论、证据、路径清单等）' },
            tags: { type: 'array', items: { type: 'string' } },
          },
          required: ['key', 'value'],
        },
        async handler(args: { key?: string; value?: unknown; tags?: string[] }, tctx: ToolContext) {
          const key = String(args.key ?? '').trim();
          if (!key) return { ok: false, error: '缺少 key' };
          try {
            return { ok: true, data: service.put(tctx.sessionId ?? '_default', key, args.value, args.tags, tctx.tenantId) };
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        version: '2.0.0',
        permissions: ["workspace.read"],
        name: 'blackboard_get',
        risk: 'low',
        costHint: 'low',
        sideEffect: 'read',
        contentTrust: 'untrusted',
        outputSchema: {
          type: 'object', required: ['key', 'value'],
          properties: { key: { type: 'string' }, value: {}, tags: { type: 'array' }, updatedAt: { type: 'integer' } },
        },
        description: '读取会话共享黑板中的一个 key。',
        parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
        async handler(args: { key?: string }, tctx: ToolContext) {
          const key = String(args.key ?? '');
          const entry = service.get(tctx.sessionId ?? '_default', key, tctx.tenantId);
          if (!entry) return { ok: false, error: `黑板 key 不存在: ${key}` };
          return { ok: true, data: { key, value: entry.value, tags: entry.tags, updatedAt: entry.updatedAt } };
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        version: '2.0.0',
        permissions: ["workspace.read"],
        name: 'blackboard_list',
        risk: 'low',
        costHint: 'low',
        sideEffect: 'read',
        outputSchema: {
          type: 'object', required: ['count', 'entries'],
          properties: { count: { type: 'integer' }, entries: { type: 'array' } },
        },
        description: '列出当前会话共享黑板的 key、标签和更新时间。',
        parameters: {
          type: 'object',
          properties: { prefix: { type: 'string', description: '可选 key 前缀' } },
        },
        async handler(args: { prefix?: string }, tctx: ToolContext) {
          const prefix = String(args.prefix ?? '');
          const entries = service.list(tctx.sessionId ?? '_default', prefix, tctx.tenantId);
          return { ok: true, data: { count: entries.length, entries } };
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        version: '2.0.0',
        permissions: ["workspace.read","workspace.write"],
        name: 'blackboard_delete',
        risk: 'low',
        costHint: 'low',
        sideEffect: 'write',
        outputSchema: {
          type: 'object', required: ['removed'],
          properties: { removed: { type: 'string' } },
        },
        description: '删除当前会话共享黑板中的一个 key。',
        parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
        async handler(args: { key?: string }, tctx: ToolContext) {
          const key = String(args.key ?? '');
          if (!service.delete(tctx.sessionId ?? '_default', key, tctx.tenantId)) return { ok: false, error: `黑板 key 不存在: ${key}` };
          return { ok: true, data: { removed: key } };
        },
      },
    });

    ctx.logger.info(`共享黑板就绪：blackboard_put / get / list / delete（会话 ${Object.keys(data).length} 个）`);
  },
} satisfies Plugin;
