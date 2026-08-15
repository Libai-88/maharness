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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { Plugin, ToolContext } from '../../kernel/types';

export type TodoStatus = 'todo' | 'doing' | 'done' | 'blocked';

export interface TodoCard {
  id: string;
  title: string;
  desc?: string;
  status: TodoStatus;
  source: 'agent' | 'human';   // 谁创建的：模型（to do list）还是人类（看板）
  sessionId?: string;          // 关联会话：模型建的卡片挂到当前会话
  createdAt: number;
  updatedAt: number;
}

const STATUSES: TodoStatus[] = ['todo', 'doing', 'done', 'blocked'];
const MAX_CARDS = 500;

// 项目根 = 本文件上溯两级（core/todo/index.ts → <root>/web-agent）
const rootDir = fileURLToPath(new URL('../..', import.meta.url));
const dataFile = join(rootDir, 'data', 'todo.json');

export default {
  id: 'todo',
  name: '待办看板',
  version: '0.1.0',
  onLoad(ctx) {
    // ---- 数据源：内存 + 落盘（data/todo.json，跨重启保留） ----
    let cards: TodoCard[] = [];
    try {
      if (existsSync(dataFile)) {
        const raw = JSON.parse(readFileSync(dataFile, 'utf8')) as { cards?: TodoCard[] };
        cards = Array.isArray(raw.cards) ? raw.cards : [];
        if (cards.length) console.log(`[todo] 已从磁盘恢复 ${cards.length} 张卡片`);
      }
    } catch (err) {
      console.warn('[todo] 加载失败（从空开始）:', err instanceof Error ? err.message : String(err));
    }
    const save = () => {
      try {
        mkdirSync(dirname(dataFile), { recursive: true });
        writeFileSync(dataFile, JSON.stringify({ cards }, null, 2), 'utf8');
      } catch (err) {
        console.warn('[todo] 持久化失败（不影响运行）:', err instanceof Error ? err.message : String(err));
      }
    };
    const notify = (reason: string) => {
      ctx.bus.emit({ type: 'todo.updated', data: { cards, reason, ts: Date.now() }, ts: Date.now() });
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
          '1. 用户请求包含多个步骤（>=3 步）时，先用 todo_add 逐项建立任务清单（一项一条）；',
          '2. 执行过程中每开始/完成/受阻一步，用 todo_update 更新状态（doing/done/blocked），保持清单与真实进度一致；',
          '3. 清单是给用户看的实时进度，也是你自己的执行索引——开始前看一眼，避免漏步；',
          '4. 单步任务（1-2 步）不要建清单，直接执行；',
          '5. 用户可在「待办看板」面板手动调整卡片，执行时以看板最新状态为准。',
        ].join('\n'),
      },
    });

    // ---- 模型 to do list 工具 ----
    ctx.register({
      kind: 'tool',
      tool: {
        name: 'todo_add',
        risk: 'low',
        costHint: 'low',
        output: '{id, title, status}',
        description: '向当前会话的 to do list 添加一项任务卡片（状态默认为 todo）。多步任务先逐项添加，执行中逐项更新。',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '任务标题（一句话，动词开头）' },
            desc: { type: 'string', description: '补充说明（可选）' },
          },
          required: ['title'],
        },
        async handler(args: { title?: string; desc?: string }, tctx: ToolContext) {
          const title = String(args.title ?? '').trim();
          if (!title) return { ok: false, error: '缺少 title' };
          if (title.length > 200) return { ok: false, error: 'title 过长（≤200 字符）' };
          if (cards.length >= MAX_CARDS) return { ok: false, error: `卡片已达上限（${MAX_CARDS}），请先清理已完成项` };
          const card: TodoCard = {
            id: `td-${randomUUID().slice(0, 8)}`,
            title,
            desc: args.desc ? String(args.desc).slice(0, 500) : undefined,
            status: 'todo',
            source: 'agent',
            sessionId: tctx.sessionId,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          cards.push(card);
          save();
          notify('agent-add');
          return { ok: true, data: { id: card.id, title: card.title, status: card.status, sessionId: card.sessionId } };
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        name: 'todo_update',
        risk: 'low',
        costHint: 'low',
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
        async handler(args: { id?: string; status?: string; note?: string }) {
          const card = cards.find((c) => c.id === args.id);
          if (!card) return { ok: false, error: `任务不存在: ${args.id}（todo_list 查看当前清单）` };
          const status = STATUSES.includes(args.status as TodoStatus) ? args.status as TodoStatus : 'todo';
          card.status = status;
          card.updatedAt = Date.now();
          if (args.note) card.desc = String(args.note).slice(0, 500);
          save();
          notify('agent-update');
          return { ok: true, data: { id: card.id, title: card.title, status: card.status } };
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        name: 'todo_list',
        risk: 'low',
        costHint: 'low',
        output: '{cards: [{id, title, status, desc?, source}]}',
        description: '查看 to do list 当前清单（本会话的卡片；传 all=true 查看跨会话全部）。执行多步任务前先查看，避免漏步。',
        parameters: {
          type: 'object',
          properties: {
            all: { type: 'boolean', description: 'true = 查看全部会话的卡片；默认只看当前会话' },
          },
        },
        async handler(args: { all?: boolean }, tctx: ToolContext) {
          const list = args.all === true ? cards : cards.filter((c) => !c.sessionId || c.sessionId === tctx.sessionId);
          const sorted = [...list].sort((a, b) => a.createdAt - b.createdAt);
          return {
            ok: true,
            data: {
              cards: sorted.map((c) => ({ id: c.id, title: c.title, status: c.status, desc: c.desc, source: c.source })),
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
        router: (async (req: { method?: string; path?: string; body?: unknown }, res: {
          json: (v: unknown) => void; status: (n: number) => { json: (v: unknown) => void };
        }) => {
          // 挂载前缀剥离：请求 /api/plugins/todo/board/cards → req.path=/board/cards → p=/cards
          const raw = (req.path ?? '/').replace(/\/+$/, '') || '/';
          let p = raw;
          if (p === '/board') p = '/';
          else if (p.startsWith('/board/')) p = p.slice('/board'.length);
          const body = (req.body ?? {}) as Record<string, unknown>;
          const send = (v: unknown) => res.json(v);

          // ---- 面板（前端插件详情页渲染） ----
          if (p === '/' || p === '/panel') {
            send({
              title: '待办看板',
              html: boardHtml(),
            });
            return;
          }

          // ---- REST：看板数据 ----
          if (req.method === 'GET' && p === '/cards') {
            send({ cards: [...cards].sort((a, b) => a.createdAt - b.createdAt) });
            return;
          }
          if (req.method === 'POST' && p === '/cards') {
            const title = String(body.title ?? '').trim();
            if (!title) return res.status(400).json({ error: '缺少 title' });
            if (cards.length >= MAX_CARDS) return res.status(400).json({ error: '卡片已达上限' });
            const card: TodoCard = {
              id: `td-${randomUUID().slice(0, 8)}`,
              title,
              desc: body.desc ? String(body.desc).slice(0, 500) : undefined,
              status: (STATUSES.includes(body.status as TodoStatus) ? body.status : 'todo') as TodoStatus,
              source: 'human',
              createdAt: Date.now(),
              updatedAt: Date.now(),
            };
            cards.push(card);
            save();
            notify('human-add');
            send({ ok: true, card });
            return;
          }
          const m = p.match(/^\/cards\/([^/]+)$/);
          if (m) {
            const id = m[1];
            const card = cards.find((c) => c.id === id);
            if (!card) return res.status(404).json({ error: '卡片不存在' });
            if (req.method === 'PATCH') {
              if (body.status && STATUSES.includes(body.status as TodoStatus)) card.status = body.status as TodoStatus;
              if (body.title) card.title = String(body.title).slice(0, 200);
              if (typeof body.desc === 'string') card.desc = body.desc.slice(0, 500) || undefined;
              card.updatedAt = Date.now();
              save();
              notify('human-update');
              send({ ok: true, card });
              return;
            }
            if (req.method === 'DELETE') {
              cards = cards.filter((c) => c.id !== id);
              save();
              notify('human-delete');
              send({ ok: true });
              return;
            }
          }
          if (req.method === 'POST' && p === '/clear-done') {
            cards = cards.filter((c) => c.status !== 'done');
            save();
            notify('human-clear-done');
            send({ ok: true, removed: cards.length });
            return;
          }
          res.status(404).json({ error: '未知端点' });
        }) as never,
      },
    });

    ctx.logger.info('工具就绪: todo_add / todo_update / todo_list + 看板面板（/api/plugins/todo/board/panel）');
  },
} satisfies Plugin;

/** 看板面板 HTML：三列（待办/进行中/完成）+ 受阻标记，内联 JS 调 REST（面板沙箱化，无外部依赖） */
function boardHtml(): string {
  return `<!doctype html>
<div id="todo-app" style="font-family:system-ui,-apple-system,sans-serif;color:#d8dae5">
  <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px">
    <b style="font-size:15px">待办看板</b>
    <span id="todo-summary" style="font-size:12px;color:#8b8fa3"></span>
    <span style="flex:1"></span>
    <input id="todo-new-title" placeholder="新任务标题…" style="background:#151826;border:1px solid #2a3045;border-radius:6px;padding:5px 9px;font-size:12px;color:#d8dae5;width:200px" />
    <button onclick="todoAdd()" style="background:var(--accent,#7c6cff);border:none;border-radius:6px;padding:5px 12px;font-size:12px;color:#fff;cursor:pointer">添加</button>
  </div>
  <div id="todo-cols" style="display:flex;gap:10px;align-items:flex-start"></div>
</div>
<script>
const COLS = [
  { key: 'todo', label: '待办', color: '#f0b429' },
  { key: 'doing', label: '进行中', color: '#4aa3ff' },
  { key: 'blocked', label: '受阻', color: '#ff6b6b' },
  { key: 'done', label: '完成', color: '#2ecc8f' },
];
async function loadTodos() {
  const r = await fetch('/api/plugins/todo/board/cards');
  const d = await r.json();
  render(d.cards || []);
}
function render(cards) {
  document.getElementById('todo-summary').textContent = cards.filter(c=>c.status==='done').length + '/' + cards.length + ' 完成';
  const root = document.getElementById('todo-cols');
  root.innerHTML = '';
  for (const col of COLS) {
    const list = cards.filter(c => c.status === col.key);
    const colEl = document.createElement('div');
    colEl.style.cssText = 'flex:1;min-width:150px;background:#10131f;border:1px solid #232a40;border-radius:10px;padding:10px';
    colEl.innerHTML = '<div style="font-size:12px;font-weight:600;margin-bottom:8px;color:' + col.color + '">' + col.label + ' <span style="color:#8b8fa3">(' + list.length + ')</span></div>';
    for (const c of list) {
      const card = document.createElement('div');
      card.style.cssText = 'background:#181c2c;border:1px solid #2a3045;border-radius:8px;padding:8px 10px;margin-bottom:8px;font-size:12px';
      card.innerHTML =
        '<div style="font-weight:600;margin-bottom:4px">' + esc(c.title) + (c.source === 'agent' ? ' <span style="font-size:10px;color:#7c6cff">🤖</span>' : ' <span style="font-size:10px;color:#8b8fa3">👤</span>') + '</div>' +
        (c.desc ? '<div style="color:#8b8fa3;margin-bottom:6px;white-space:pre-wrap">' + esc(c.desc) + '</div>' : '') +
        '<div style="display:flex;gap:4px;flex-wrap:wrap">' +
          COLS.filter(x => x.key !== c.status).map(x => '<button onclick="todoSet(\'' + c.id + '\',\'' + x.key + '\')" style="background:#232a40;border:none;border-radius:5px;padding:2px 7px;font-size:10px;color:#aab0c5;cursor:pointer">' + x.label + '</button>').join('') +
          '<button onclick="todoDel(\'' + c.id + '\')" style="background:#232a40;border:none;border-radius:5px;padding:2px 7px;font-size:10px;color:#ff6b6b;cursor:pointer">删除</button>' +
        '</div>';
      colEl.appendChild(card);
    }
    root.appendChild(colEl);
  }
}
async function todoAdd() {
  const title = document.getElementById('todo-new-title').value.trim();
  if (!title) return;
  await fetch('/api/plugins/todo/board/cards', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) });
  document.getElementById('todo-new-title').value = '';
  loadTodos();
}
async function todoSet(id, status) {
  await fetch('/api/plugins/todo/board/cards/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
  loadTodos();
}
async function todoDel(id) {
  await fetch('/api/plugins/todo/board/cards/' + id, { method: 'DELETE' });
  loadTodos();
}
loadTodos();
</script>`;
}
