/**
 * core/todo/index.ts —— 待办看板 + 模型 to do list 插件
 * 第一性原理：多步任务的进度是「已被观察过的现实」——把每一步从"记忆里"移到
 * "看板上"，人（看板面板）与模型（todo 工具）看到同一份事实，谁也不靠猜。
 * 两面视图，同一数据源：
 *  - 模型 to do list：todo_add / todo_update / todo_list 工具（LLM 执行任务时
 *    边做边维护清单，todo.updated 事件实时推送到前端）；
 *  - 待办看板：api 能力提供 REST + 前端面板（人类手动增删改，看全部卡片）。
 * 卡片按 sessionId 关联会话：模型建的卡片挂在当前会话（会话级 to do list），
 * 看板展示全部（跨会话视图）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Plugin, ToolContext } from '../../kernel/types';

export type TodoStatus = 'todo' | 'doing' | 'done' | 'blocked';
export type TodoPriority = 'low' | 'medium' | 'high' | 'urgent';

export interface TodoCard {
  id: string;
  title: string;
  desc?: string;
  status: TodoStatus;
  priority: TodoPriority;      // 优先级：low / medium / high / urgent
  source: 'agent' | 'human';   // 谁创建的：模型（to do list）还是人类（看板）
  sessionId?: string;          // 关联会话：模型建的卡片挂到当前会话
  tenantId?: string;           // 租户归属：缺省按 default 兼容旧数据
  order: number;               // 列内排序（拖拽重排）
  createdAt: number;
  updatedAt: number;
}

const STATUSES: TodoStatus[] = ['todo', 'doing', 'done', 'blocked'];
const PRIORITIES: TodoPriority[] = ['low', 'medium', 'high', 'urgent'];
const MAX_CARDS = 500;
const MAX_CARDS_PER_TENANT = 200;

const tenantOf = (card: TodoCard): string => card.tenantId ?? 'default';

export default {
  id: 'todo',
  name: '待办看板',
  version: '0.1.0',
  onLoad(ctx) {
    // 数据目录跟随 Kernel 的 dataDir 覆盖（AGENT_DATA_DIR/测试隔离），不写死源码树 data/
    const dataFile = join(ctx.paths.data, 'todo.json');
    // ---- 数据源：内存 + 落盘（data/todo.json，跨重启保留） ----
    let cards: TodoCard[] = [];
    try {
      if (existsSync(dataFile)) {
        const raw = JSON.parse(readFileSync(dataFile, 'utf8')) as { cards?: TodoCard[] };
        cards = Array.isArray(raw.cards) ? raw.cards : [];
        // 迁移：旧卡片补全 priority + order 字段
        cards.forEach((c, i) => {
          if (!c.priority) c.priority = 'medium';
          if (typeof c.order !== 'number') c.order = i;
        });
        if (cards.length) console.log(`[todo] 已从磁盘恢复 ${cards.length} 张卡片`);
      }
    } catch (err) {
      console.warn('[todo] 加载失败（从空开始）:', err instanceof Error ? err.message : String(err));
    }
    const save = () => {
      try {
        mkdirSync(dirname(dataFile), { recursive: true });
        // 原子写：先临时文件再 rename——崩溃/断电不留下截断 JSON
        const tmp = `${dataFile}.tmp`;
        writeFileSync(tmp, JSON.stringify({ cards }, null, 2), 'utf8');
        renameSync(tmp, dataFile);
      } catch (err) {
        console.warn('[todo] 持久化失败（不影响运行）:', err instanceof Error ? err.message : String(err));
      }
    };
    const notify = (reason: string, tenantId = 'default') => {
      ctx.bus.emit({
        type: 'todo.updated',
        data: { cards: cards.filter((card) => tenantOf(card) === tenantId), reason, tenantId, ts: Date.now() },
        ts: Date.now(),
      });
    };

    // ---- L2 人设：引导 LLM 执行多步任务时维护 to do list ----
    ctx.register({
      kind: 'persona',
      persona: {
        id: 'todo-rules',
        name: 'to do list 使用规则',
        description: '引导 LLM 对多步任务建立并实时维护可见的 to do list',
        priority: 5,
        content: [
          'to do list 使用规则：',
          '多步任务可用 todo_add 建立可见清单，用 todo_update 保持真实进度；单步任务直接执行。用户手动调整后以看板最新状态为准。',
        ].join('\n'),
      },
    });

    // ---- 模型 to do list 工具 ----
    ctx.register({
      kind: 'tool',
      tool: {
        version: '2.0.0',
        permissions: ["workspace.read","workspace.write"],
        name: 'todo_add',
        risk: 'low',
        costHint: 'low',
        sideEffect: 'write',
        output: '{id, title, status}',
        outputSchema: {
          type: 'object', required: ['id', 'title', 'status'],
          properties: { id: { type: 'string' }, title: { type: 'string' }, status: { type: 'string' }, sessionId: { type: 'string' } },
        },
        description: '向当前会话的 to do list 添加一项任务卡片（状态默认为 todo）。多步任务先逐项添加，执行中逐项更新。',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '任务标题（一句话，动词开头）' },
            desc: { type: 'string', description: '补充说明（可选）' },
            priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'], description: '优先级（默认 medium）' },
          },
          required: ['title'],
        },
        async handler(args: { title?: string; desc?: string; priority?: string }, tctx: ToolContext) {
          const title = String(args.title ?? '').trim();
          if (!title) return { ok: false, error: '缺少 title' };
          if (title.length > 200) return { ok: false, error: 'title 过长（≤200 字符）' };
          const tenantId = tctx.tenantId ?? 'default';
          const tenantCards = cards.filter((card) => tenantOf(card) === tenantId);
          if (cards.length >= MAX_CARDS) return { ok: false, error: `全局卡片已达上限（${MAX_CARDS}），请先清理已完成项` };
          if (tenantCards.length >= MAX_CARDS_PER_TENANT) return { ok: false, error: `当前租户卡片已达上限（${MAX_CARDS_PER_TENANT}），请先清理已完成项` };
          const maxOrder = tenantCards.reduce((m, c) => Math.max(m, c.order ?? 0), -1);
          const priority = PRIORITIES.includes(args.priority as TodoPriority) ? args.priority as TodoPriority : 'medium';
          const card: TodoCard = {
            id: `td-${randomUUID()}`,
            title,
            desc: args.desc ? String(args.desc).slice(0, 500) : undefined,
            status: 'todo',
            priority,
            source: 'agent',
            sessionId: tctx.sessionId,
            tenantId,
            order: maxOrder + 1,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          cards.push(card);
          save();
          notify('agent-add', tenantId);
          return { ok: true, data: { id: card.id, title: card.title, status: card.status, sessionId: card.sessionId } };
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        version: '2.0.0',
        permissions: ["workspace.read","workspace.write"],
        name: 'todo_update',
        risk: 'low',
        costHint: 'low',
        sideEffect: 'write',
        output: '{id, title, status}',
        outputSchema: {
          type: 'object', required: ['id', 'title', 'status'],
          properties: { id: { type: 'string' }, title: { type: 'string' }, status: { type: 'string' } },
        },
        description: '更新 to do list 中一项任务的状态：doing（进行中）/ done（完成）/ blocked（受阻）/ todo（回到待办）。可附进度说明。',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '任务 id（todo_list 或添加时返回）' },
            status: { type: 'string', enum: ['todo', 'doing', 'done', 'blocked'], description: '新状态' },
            note: { type: 'string', description: '进度说明/完成摘要/受阻原因（可选，展示在看板卡片上）' },
          },
          required: ['id', 'status'],
        },
        async handler(args: { id?: string; status?: string; note?: string }, tctx: ToolContext) {
          const tenantId = tctx.tenantId ?? 'default';
          const card = cards.find((c) => c.id === args.id && tenantOf(c) === tenantId);
          if (!card) return { ok: false, error: `任务不存在: ${args.id}（todo_list 查看当前清单）` };
          const status = STATUSES.includes(args.status as TodoStatus) ? args.status as TodoStatus : 'todo';
          card.status = status;
          card.updatedAt = Date.now();
          if (args.note) card.desc = String(args.note).slice(0, 500);
          save();
          notify('agent-update', tenantId);
          return { ok: true, data: { id: card.id, title: card.title, status: card.status } };
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        version: '2.0.0',
        permissions: ["workspace.read"],
        name: 'todo_list',
        risk: 'low',
        costHint: 'low',
        sideEffect: 'read',
        output: '{cards: [{id, title, status, desc?, source}]}',
        outputSchema: {
          type: 'object', required: ['cards', 'summary'],
          properties: { cards: { type: 'array' }, summary: { type: 'string' } },
        },
        description: '查看 to do list 当前清单（本会话的卡片；传 all=true 查看跨会话全部）。执行多步任务前先查看，避免漏步。',
        parameters: {
          type: 'object',
          properties: {
            all: { type: 'boolean', description: 'true = 查看全部会话的卡片；默认只看当前会话' },
          },
        },
        async handler(args: { all?: boolean }, tctx: ToolContext) {
          const tenantId = tctx.tenantId ?? 'default';
          const tenantCards = cards.filter((card) => tenantOf(card) === tenantId);
          const list = args.all === true
            ? tenantCards
            : tenantCards.filter((c) => !c.sessionId || c.sessionId === tctx.sessionId);
          const sorted = [...list].sort((a, b) => a.createdAt - b.createdAt);
          return {
            ok: true,
            data: {
              cards: sorted.map((c) => ({ id: c.id, title: c.title, status: c.status, priority: c.priority, desc: c.desc, source: c.source })),
              summary: `${sorted.filter((c) => c.status === 'done').length}/${sorted.length} 完成`,
            },
          };
        },
      },
    });

    // ---- 待办看板：REST API + 前端面板（api 能力） ----
    ctx.register({
      kind: 'api',
      api: {
        mount: 'board',
        responses: {
          'GET /panel': { type: 'object', required: ['title', 'html'], properties: { title: { type: 'string' }, html: { type: 'string' } } },
          'GET /cards': { type: 'object', required: ['cards'], properties: { cards: { type: 'array' } } },
          'POST /cards': { type: 'object', required: ['ok', 'card'], properties: { ok: { type: 'boolean' }, card: { type: 'object' } } },
          'PATCH /cards/:id': { type: 'object', required: ['ok', 'card'], properties: { ok: { type: 'boolean' }, card: { type: 'object' } } },
          'DELETE /cards/:id': { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
          'PATCH /cards/reorder': { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
          'POST /clear-done': { type: 'object', required: ['ok', 'removed'], properties: { ok: { type: 'boolean' }, removed: { type: 'integer' } } },
        },
        router: (async (req: { method?: string; path?: string; body?: unknown; tenantId?: string }, res: {
          json: (v: unknown) => void; status: (n: number) => { json: (v: unknown) => void };
        }) => {
          // 挂载前缀剥离：请求 /api/plugins/todo/board/cards → req.path=/board/cards → p=/cards
          const raw = (req.path ?? '/').replace(/\/+$/, '') || '/';
          let p = raw;
          if (p === '/board') p = '/';
          else if (p.startsWith('/board/')) p = p.slice('/board'.length);
          const body = (req.body ?? {}) as Record<string, unknown>;
          const send = (v: unknown) => res.json(v);
          const tenantId = req.tenantId ?? 'default';
          const tenantCards = cards.filter((card) => tenantOf(card) === tenantId);

          // ---- 面板（前端插件详情页渲染） ----
          if (p === '/' || p === '/panel') {
            send({
              title: '待办看板',
              html: boardHtml(tenantCards),
            });
            return;
          }

          // ---- 独立窗口页面 ----
          if (p === '/page') {
            const r = res as unknown as {
              writeHead: (n: number, h?: Record<string, string>) => void;
              end: (s: string) => void;
            };
            r.writeHead(302, { Location: '/todo.html' });
            r.end('');
            return;
          }

          // ---- REST：看板数据 ----
          if (req.method === 'GET' && p === '/cards') {
            send({ cards: [...tenantCards].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)) });
            return;
          }
          if (req.method === 'POST' && p === '/cards') {
            const title = String(body.title ?? '').trim();
            if (!title) return res.status(400).json({ error: '缺少 title' });
            if (title.length > 200) return res.status(400).json({ error: 'title 过长（≤200 字符）' });
            if (cards.length >= MAX_CARDS) return res.status(400).json({ error: `全局卡片已达上限（${MAX_CARDS}）` });
            if (tenantCards.length >= MAX_CARDS_PER_TENANT) return res.status(400).json({ error: `当前租户卡片已达上限（${MAX_CARDS_PER_TENANT}）` });
            const maxOrder = tenantCards.reduce((m, c) => Math.max(m, c.order ?? 0), -1);
            const priority = PRIORITIES.includes(body.priority as TodoPriority) ? body.priority as TodoPriority : 'medium';
            const card: TodoCard = {
              id: `td-${randomUUID()}`,
              title,
              desc: body.desc ? String(body.desc).slice(0, 500) : undefined,
              status: (STATUSES.includes(body.status as TodoStatus) ? body.status : 'todo') as TodoStatus,
              priority,
              source: 'human',
              tenantId,
              order: maxOrder + 1,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            };
            cards.push(card);
            save();
            notify('human-add', tenantId);
            send({ ok: true, card });
            return;
          }
          // ---- 批量重排（拖拽后一次性提交）----
          // 必须先于 /cards/:id 匹配：否则 "reorder" 会被当成卡片 id 而 404。
          if (req.method === 'PATCH' && p === '/cards/reorder') {
            const updates = body.cards as { id: string; status?: string; order?: number }[] | undefined;
            if (!Array.isArray(updates)) return res.status(400).json({ error: '缺少 cards 数组' });
            for (const u of updates) {
              const card = cards.find((c) => c.id === u.id && tenantOf(c) === tenantId);
              if (!card) continue;
              if (u.status && STATUSES.includes(u.status as TodoStatus)) card.status = u.status as TodoStatus;
              if (typeof u.order === 'number' && Number.isFinite(u.order)) card.order = u.order;
              card.updatedAt = Date.now();
            }
            save();
            notify('human-reorder', tenantId);
            send({ ok: true });
            return;
          }
          const m = p.match(/^\/cards\/([^/]+)$/);
          if (m) {
            const id = m[1];
            const card = cards.find((c) => c.id === id && tenantOf(c) === tenantId);
            if (!card) return res.status(404).json({ error: '卡片不存在' });
            if (req.method === 'PATCH') {
              if (body.status && STATUSES.includes(body.status as TodoStatus)) card.status = body.status as TodoStatus;
              if (body.title) card.title = String(body.title).slice(0, 200);
              if (typeof body.desc === 'string') card.desc = body.desc.slice(0, 500) || undefined;
              if (body.priority && PRIORITIES.includes(body.priority as TodoPriority)) card.priority = body.priority as TodoPriority;
              if (typeof body.order === 'number') card.order = body.order;
              card.updatedAt = Date.now();
              save();
              notify('human-update', tenantId);
              send({ ok: true, card });
              return;
            }
            if (req.method === 'DELETE') {
              cards = cards.filter((c) => c.id !== id);
              save();
              notify('human-delete', tenantId);
              send({ ok: true });
              return;
            }
          }
          if (req.method === 'POST' && p === '/clear-done') {
            const before = tenantCards.filter((c) => c.status === 'done').length;
            cards = cards.filter((c) => !(tenantOf(c) === tenantId && c.status === 'done'));
            save();
            notify('human-clear-done', tenantId);
            send({ ok: true, removed: before });
            return;
          }
          res.status(404).json({ error: '未知端点' });
        }) as never,
      },
    });

    ctx.logger.info('工具就绪: todo_add / todo_update / todo_list + 看板面板（/api/plugins/todo/board/panel）');
  },
} satisfies Plugin;

function boardHtml(cards: TodoCard[]): string {
  const counts = STATUSES.map((status) => cards.filter((card) => card.status === status).length);
  return `<p>待办 ${counts[0]} · 进行中 ${counts[1]} · 完成 ${counts[2]} · 受阻 ${counts[3]}</p><p><a href="/api/plugins/todo/board/page" target="_blank" rel="noopener noreferrer">打开待办看板</a></p>`;
}
