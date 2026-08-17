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
export type TodoPriority = 'low' | 'medium' | 'high' | 'urgent';

export interface TodoCard {
  id: string;
  title: string;
  desc?: string;
  status: TodoStatus;
  priority: TodoPriority;      // 优先级：low / medium / high / urgent
  source: 'agent' | 'human';   // 谁创建的：模型（to do list）还是人类（看板）
  sessionId?: string;          // 关联会话：模型建的卡片挂到当前会话
  order: number;               // 列内排序（拖拽重排）
  createdAt: number;
  updatedAt: number;
}

const STATUSES: TodoStatus[] = ['todo', 'doing', 'done', 'blocked'];
const PRIORITIES: TodoPriority[] = ['low', 'medium', 'high', 'urgent'];
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
            priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'], description: '优先级（默认 medium）' },
          },
          required: ['title'],
        },
        async handler(args: { title?: string; desc?: string; priority?: string }, tctx: ToolContext) {
          const title = String(args.title ?? '').trim();
          if (!title) return { ok: false, error: '缺少 title' };
          if (title.length > 200) return { ok: false, error: 'title 过长（≤200 字符）' };
          if (cards.length >= MAX_CARDS) return { ok: false, error: `卡片已达上限（${MAX_CARDS}），请先清理已完成项` };
          const maxOrder = cards.reduce((m, c) => Math.max(m, c.order ?? 0), -1);
          const priority = PRIORITIES.includes(args.priority as TodoPriority) ? args.priority as TodoPriority : 'medium';
          const card: TodoCard = {
            id: `td-${randomUUID().slice(0, 8)}`,
            title,
            desc: args.desc ? String(args.desc).slice(0, 500) : undefined,
            status: 'todo',
            priority,
            source: 'agent',
            sessionId: tctx.sessionId,
            order: maxOrder + 1,
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

          // ---- 独立窗口页面（完整 HTML：window.open 单独打开，人物主题背景） ----
          if (p === '/page') {
            const full = boardPageHtml();
            const r = res as unknown as {
              writeHead: (n: number, h?: Record<string, string>) => void;
              end: (s: string) => void;
            };
            r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            r.end(full);
            return;
          }

          // ---- REST：看板数据 ----
          if (req.method === 'GET' && p === '/cards') {
            send({ cards: [...cards].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)) });
            return;
          }
          if (req.method === 'POST' && p === '/cards') {
            const title = String(body.title ?? '').trim();
            if (!title) return res.status(400).json({ error: '缺少 title' });
            if (cards.length >= MAX_CARDS) return res.status(400).json({ error: '卡片已达上限' });
            const maxOrder = cards.reduce((m, c) => Math.max(m, c.order ?? 0), -1);
            const priority = PRIORITIES.includes(body.priority as TodoPriority) ? body.priority as TodoPriority : 'medium';
            const card: TodoCard = {
              id: `td-${randomUUID().slice(0, 8)}`,
              title,
              desc: body.desc ? String(body.desc).slice(0, 500) : undefined,
              status: (STATUSES.includes(body.status as TodoStatus) ? body.status : 'todo') as TodoStatus,
              priority,
              source: 'human',
              order: maxOrder + 1,
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
              if (body.priority && PRIORITIES.includes(body.priority as TodoPriority)) card.priority = body.priority as TodoPriority;
              if (typeof body.order === 'number') card.order = body.order;
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
          // ---- 批量重排（拖拽后一次性提交） ----
          if (req.method === 'PATCH' && p === '/cards/reorder') {
            const updates = body.cards as { id: string; status?: string; order?: number }[] | undefined;
            if (!Array.isArray(updates)) return res.status(400).json({ error: '缺少 cards 数组' });
            for (const u of updates) {
              const card = cards.find((c) => c.id === u.id);
              if (!card) continue;
              if (u.status && STATUSES.includes(u.status as TodoStatus)) card.status = u.status as TodoStatus;
              if (typeof u.order === 'number') card.order = u.order;
              card.updatedAt = Date.now();
            }
            save();
            notify('human-reorder');
            send({ ok: true });
            return;
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

/** 看板面板 HTML：四列（待办/进行中/受阻/完成）+ 内联 JS 调 REST（面板沙箱化，无外部依赖） */
function boardHtml(): string {
  return `<!doctype html>
<div id="todo-app" style="font-family:system-ui,-apple-system,sans-serif;color:#d8dae5">
  <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px">
    <b style="font-size:15px">待办看板</b>
    <span id="todo-summary" style="font-size:12px;color:#8b8fa3"></span>
    <span style="flex:1"></span>
    <button onclick="window.open('/api/plugins/todo/board/page','_blank')" style="background:#232a40;border:none;border-radius:6px;padding:5px 12px;font-size:12px;color:#aab0c5;cursor:pointer" title="在独立窗口打开看板">⛶ 独立窗口</button>
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
const esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
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
          COLS.filter(x => x.key !== c.status).map(x => '<button class="t-act" data-id="' + c.id + '" data-status="' + x.key + '" style="background:#232a40;border:none;border-radius:5px;padding:2px 7px;font-size:10px;color:#aab0c5;cursor:pointer">' + x.label + '</button>').join('') +
          '<button class="t-act" data-id="' + c.id + '" data-del="1" style="background:#232a40;border:none;border-radius:5px;padding:2px 7px;font-size:10px;color:#ff6b6b;cursor:pointer">删除</button>' +
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
// 事件委托：任何 .t-act 按钮点击统一分发（data-id/data-status/data-del）
document.addEventListener('click', async (e) => {
  const btn = e.target && e.target.closest ? e.target.closest('button.t-act') : null;
  if (!btn) return;
  const id = btn.dataset.id;
  if (btn.dataset.del) { await todoDel(id); return; }
  await todoSet(id, btn.dataset.status);
});
loadTodos();
</script>`;
}

/**
 * 独立窗口页面：完整 HTML（非面板片段），人物主题背景 + 玻璃拟态看板。
 * 通过 /api/plugins/todo/board/page 访问（插件详情页「独立窗口」按钮 window.open）。
 */
function boardPageHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>待办看板 · maharness</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
    color: #e8eaf2;
    background:
      linear-gradient(180deg, rgba(10,12,18,.55) 0%, rgba(10,12,18,.30) 40%, rgba(10,12,18,.34) 60%, rgba(10,12,18,.60) 100%),
      url('/hero-char.png') center 32% / cover no-repeat fixed;
    overflow: hidden;
  }
  .app { height: 100%; display: flex; flex-direction: column; padding: 18px 22px; }
  .toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
  .toolbar h1 { font-size: 19px; font-weight: 700; letter-spacing: .5px; }
  .toolbar .summary { font-size: 12px; color: #9aa1b8; background: rgba(20,24,38,.75); border: 1px solid #2c3350; border-radius: 99px; padding: 4px 12px; backdrop-filter: blur(8px); }
  .toolbar .spacer { flex: 1; }
  .toolbar input, .toolbar select {
    background: rgba(20,24,38,.8); border: 1px solid #333b5c; border-radius: 8px;
    padding: 7px 12px; font-size: 12px; color: #e8eaf2; outline: none; backdrop-filter: blur(8px);
  }
  .toolbar input:focus, .toolbar select:focus { border-color: #7c6cff; }
  .toolbar input[type=text] { width: 180px; }
  .btn {
    background: linear-gradient(135deg, #7c6cff, #5a4bd6); border: none; border-radius: 10px;
    padding: 8px 18px; font-size: 13px; font-weight: 600; color: #fff; cursor: pointer;
    box-shadow: 0 4px 16px rgba(124,108,255,.35); transition: transform .12s;
  }
  .btn:hover { transform: translateY(-1px); }
  .cols { flex: 1; display: flex; gap: 14px; align-items: flex-start; overflow: auto; padding-bottom: 8px; }
  .col {
    flex: 1; min-width: 190px; max-height: 100%;
    display: flex; flex-direction: column;
    background: rgba(16,19,32,.72); border: 1px solid #2b3250; border-radius: 16px;
    padding: 12px; backdrop-filter: blur(12px); box-shadow: 0 8px 28px rgba(0,0,0,.35);
  }
  .col.drag-over { border-color: #7c6cff; background: rgba(124,108,255,.08); }
  .col-head { font-size: 12.5px; font-weight: 700; margin-bottom: 10px; display: flex; align-items: center; gap: 6px; }
  .col-head .count { font-size: 11px; color: #8b93ad; background: rgba(255,255,255,.06); border-radius: 99px; padding: 1px 8px; }
  .col-body { overflow-y: auto; display: flex; flex-direction: column; gap: 8px; min-height: 40px; }
  .card {
    background: rgba(26,30,48,.82); border: 1px solid #333b5c; border-radius: 12px;
    padding: 10px 12px; font-size: 12.5px; backdrop-filter: blur(6px);
    box-shadow: 0 2px 10px rgba(0,0,0,.25); transition: transform .1s, opacity .15s;
    cursor: grab; user-select: none;
  }
  .card:hover { transform: translateY(-1px); border-color: #4a5380; }
  .card.dragging { opacity: .4; }
  .card .title { font-weight: 600; margin-bottom: 4px; display: flex; align-items: center; gap: 6px; }
  .card .pri { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
  .card .src { font-size: 10px; opacity: .75; }
  .card .desc { color: #9aa1b8; margin-bottom: 8px; white-space: pre-wrap; font-size: 11.5px; }
  .card .acts { display: flex; gap: 5px; flex-wrap: wrap; }
  .card .acts button {
    background: #2a3150; border: none; border-radius: 7px; padding: 3px 9px;
    font-size: 10.5px; color: #c3c9dd; cursor: pointer; transition: background .12s;
  }
  .card .acts button:hover { background: #3a4368; }
  .card .acts .del { color: #ff7b7b; }
  .col.done .card .title { color: #7d8aa8; text-decoration: line-through; }
  .empty { color: #5a6080; font-size: 11px; text-align: center; padding: 16px 0; border: 1px dashed #2b3250; border-radius: 8px; }
  /* 编辑面板 */
  .overlay { position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 100; display: flex; justify-content: flex-end; }
  .panel { width: 380px; max-width: 90vw; height: 100%; background: #14172a; border-left: 1px solid #2b3250; display: flex; flex-direction: column; }
  .panel-head { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid #2b3250; }
  .panel-head h3 { font-size: 14px; }
  .panel-head button { background: none; border: none; color: #8b93ad; cursor: pointer; font-size: 16px; }
  .panel-body { flex: 1; overflow-y: auto; padding: 16px 20px; display: flex; flex-direction: column; gap: 12px; }
  .panel-body label { font-size: 11px; font-weight: 600; color: #8b93ad; text-transform: uppercase; letter-spacing: .5px; }
  .panel-body input, .panel-body textarea {
    width: 100%; padding: 8px 10px; font-size: 13px; background: #0f1220; border: 1px solid #333b5c;
    border-radius: 7px; color: #e8eaf2; outline: none; resize: vertical;
  }
  .panel-body input:focus, .panel-body textarea:focus { border-color: #7c6cff; }
  .pri-row, .status-row { display: flex; gap: 6px; flex-wrap: wrap; }
  .pri-btn, .st-btn {
    display: flex; align-items: center; gap: 5px; padding: 5px 12px; font-size: 12px;
    border-radius: 7px; background: #0f1220; border: 1px solid #333b5c; color: #8b93ad; cursor: pointer;
  }
  .pri-btn.active, .st-btn.active { border-color: var(--pc); color: #e8eaf2; background: rgba(124,108,255,.12); }
  .panel-foot { display: flex; align-items: center; gap: 8px; padding: 12px 20px; border-top: 1px solid #2b3250; }
  .panel-foot .save { background: #7c6cff; color: #fff; border: none; border-radius: 7px; padding: 8px 18px; font-size: 12px; font-weight: 600; cursor: pointer; }
  .panel-foot .cancel { background: none; border: 1px solid #333b5c; border-radius: 7px; padding: 8px 14px; font-size: 12px; color: #8b93ad; cursor: pointer; }
  .panel-foot .danger { background: rgba(255,107,107,.12); border: 1px solid #ff6b6b; border-radius: 7px; padding: 8px 14px; font-size: 12px; color: #ff7b7b; cursor: pointer; }
</style>
</head>
<body>
<div class="app">
  <div class="toolbar">
    <h1>🗂 待办看板</h1>
    <span class="summary" id="summary"></span>
    <span class="spacer"></span>
    <input type="text" id="search" placeholder="搜索…" oninput="render()" />
    <select id="filter-status" onchange="render()">
      <option value="all">全部状态</option>
      <option value="todo">待办</option><option value="doing">进行中</option>
      <option value="blocked">受阻</option><option value="done">完成</option>
    </select>
    <select id="filter-source" onchange="render()">
      <option value="all">全部来源</option><option value="human">👤 人类</option><option value="agent">🤖 模型</option>
    </select>
    <span class="spacer"></span>
    <input type="text" id="new-title" placeholder="新任务标题…" onkeydown="if(event.key==='Enter')add()" />
    <button class="btn" onclick="add()">＋ 添加</button>
  </div>
  <div class="cols" id="cols"></div>
</div>
<div id="edit-overlay"></div>
<script>
const COLS = [
  { key: 'todo', label: '待办', color: '#f0b429' },
  { key: 'doing', label: '进行中', color: '#4aa3ff' },
  { key: 'blocked', label: '受阻', color: '#ff6b6b' },
  { key: 'done', label: '完成', color: '#2ecc8f' },
];
const PRIS = { low: '#5a6080', medium: '#f0b429', high: '#d0856b', urgent: '#ff6b6b' };
const PRI_LABEL = { low: '低', medium: '中', high: '高', urgent: '紧急' };
let ALL_CARDS = [];
let dragId = null;
const esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

function render() {
  const q = document.getElementById('search').value.toLowerCase();
  const fs = document.getElementById('filter-status').value;
  const fsrc = document.getElementById('filter-source').value;
  let cards = ALL_CARDS;
  if (fs !== 'all') cards = cards.filter(c => c.status === fs);
  if (fsrc !== 'all') cards = cards.filter(c => c.source === fsrc);
  if (q) cards = cards.filter(c => c.title.toLowerCase().includes(q) || (c.desc||'').toLowerCase().includes(q));
  document.getElementById('summary').textContent = ALL_CARDS.filter(c=>c.status==='done').length + '/' + ALL_CARDS.length + ' 完成';
  const root = document.getElementById('cols');
  root.innerHTML = '';
  for (const col of COLS) {
    const list = cards.filter(c => c.status === col.key);
    const el = document.createElement('div');
    el.className = 'col ' + col.key;
    el.dataset.col = col.key;
    el.ondragover = (e) => { e.preventDefault(); el.classList.add('drag-over'); };
    el.ondragleave = () => el.classList.remove('drag-over');
    el.ondrop = async (e) => { e.preventDefault(); el.classList.remove('drag-over'); if (dragId) await moveTo(dragId, col.key); };
    el.innerHTML = '<div class="col-head"><span style="width:8px;height:8px;border-radius:50%;background:' + col.color + '"></span>' + col.label + '<span class="count">' + list.length + '</span></div>';
    const body = document.createElement('div');
    body.className = 'col-body';
    if (!list.length) body.innerHTML = '<div class="empty">拖拽卡片到这里</div>';
    for (const c of list) {
      const card = document.createElement('div');
      card.className = 'card';
      card.draggable = true;
      card.ondragstart = () => { dragId = c.id; card.classList.add('dragging'); };
      card.ondragend = () => { dragId = null; card.classList.remove('dragging'); };
      card.ondblclick = () => openEdit(c);
      const priColor = PRIS[c.priority] || PRIS.medium;
      card.innerHTML =
        '<div class="title"><span class="pri" style="background:' + priColor + '"></span>' + esc(c.title) + '<span class="src">' + (c.source === 'agent' ? '🤖' : '👤') + '</span></div>' +
        (c.desc ? '<div class="desc">' + esc(c.desc) + '</div>' : '') +
        '<div class="acts">' +
          COLS.filter(x => x.key !== c.status).map(x => '<button class="act" data-id="' + c.id + '" data-status="' + x.key + '">' + x.label + '</button>').join('') +
          '<button class="act del" data-id="' + c.id + '" data-del="1">删除</button>' +
        '</div>';
      body.appendChild(card);
    }
    el.appendChild(body);
    root.appendChild(el);
  }
}

function openEdit(c) {
  const overlay = document.getElementById('edit-overlay');
  overlay.innerHTML = '<div class="overlay" onclick="if(event.target===this)closeEdit()"><div class="panel">' +
    '<div class="panel-head"><h3>编辑卡片</h3><button onclick="closeEdit()">✕</button></div>' +
    '<div class="panel-body">' +
      '<label>标题</label><input id="ed-title" value="' + esc(c.title) + '" />' +
      '<label>描述</label><textarea id="ed-desc" rows="4">' + esc(c.desc||'') + '</textarea>' +
      '<label>优先级</label><div class="pri-row">' + ['low','medium','high','urgent'].map(p => '<button class="pri-btn' + (c.priority===p?' active':'') + '" style="--pc:' + PRIS[p] + '" data-pri="' + p + '" onclick="setPri(this,\\'' + p + '\\')"><span class="pri" style="background:' + PRIS[p] + '"></span>' + PRI_LABEL[p] + '</button>').join('') + '</div>' +
      '<label>状态</label><div class="status-row">' + COLS.map(x => '<button class="st-btn' + (c.status===x.key?' active':'') + '" style="--pc:' + x.color + '" data-st="' + x.key + '" onclick="setSt(this,\\'' + x.key + '\\')">' + x.label + '</button>').join('') + '</div>' +
    '</div>' +
    '<div class="panel-foot"><button class="danger" onclick="del(\\'' + c.id + '\\');closeEdit()">删除</button><span style="flex:1"></span><button class="cancel" onclick="closeEdit()">取消</button><button class="save" onclick="saveEdit(\\'' + c.id + '\\')">保存</button></div>' +
  '</div></div>';
  window._editPri = c.priority; window._editSt = c.status;
}
function setPri(el, p) { document.querySelectorAll('.pri-btn').forEach(b=>b.classList.remove('active')); el.classList.add('active'); window._editPri = p; }
function setSt(el, s) { document.querySelectorAll('.st-btn').forEach(b=>b.classList.remove('active')); el.classList.add('active'); window._editSt = s; }
function closeEdit() { document.getElementById('edit-overlay').innerHTML = ''; }
async function saveEdit(id) {
  const title = document.getElementById('ed-title').value.trim();
  const desc = document.getElementById('ed-desc').value.trim();
  await fetch('/api/plugins/todo/board/cards/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, desc: desc||undefined, priority: window._editPri, status: window._editSt }) });
  closeEdit(); load();
}

async function moveTo(id, status) {
  await fetch('/api/plugins/todo/board/cards/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
  load();
}
document.addEventListener('click', async (e) => {
  const btn = e.target && e.target.closest ? e.target.closest('button.act') : null;
  if (!btn) return;
  const id = btn.dataset.id;
  if (btn.dataset.del) { await del(id); return; }
  await moveTo(id, btn.dataset.status);
});
async function add() {
  const title = document.getElementById('new-title').value.trim();
  if (!title) return;
  await fetch('/api/plugins/todo/board/cards', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) });
  document.getElementById('new-title').value = '';
  load();
}
async function del(id) {
  await fetch('/api/plugins/todo/board/cards/' + id, { method: 'DELETE' });
  load();
}
async function load() {
  const d = await (await fetch('/api/plugins/todo/board/cards')).json();
  ALL_CARDS = d.cards || [];
  render();
}
load(); setInterval(load, 5000);
</script>
</body>
</html>`;
}
