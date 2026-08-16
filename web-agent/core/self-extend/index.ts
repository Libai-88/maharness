/**
 * core/self-extend/index.ts —— 自我扩展插件（maharness 核心理念）
 * 「万物都是插件，agent 可以自己定义自己」：
 *   create_plugin  —— 生成插件骨架（plugin.json + index.ts）写入 plugins/ 现场目录，
 *                     热加载后回传状态；失败时回传错误信息，供 Agent 修复迭代。
 *   plugin_status  —— 查看 plugins/ 现场插件的加载状态 / 能力 / 错误。
 * 内核与 core/ 保持不变：新能力 = 新插件，由 Agent 自己写出（只写 plugins/ 外部空间）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin, ToolContext } from '../../kernel/types';

// 项目根 = 本文件上溯两级（core/self-extend/index.ts → <root>/）
const rootDir = fileURLToPath(new URL('../..', import.meta.url));
const userPluginsDir = join(rootDir, 'plugins');

/** 内置插件 id（防止 Agent 自建插件与产品内置能力冲突）。
 *  M8 动态化：启动时扫描 <项目根>/core/ 子目录名生成，不硬编码清单——
 *  新增内置插件自动纳入冲突防护，杜绝 create_plugin(id='memory') 注册重名插件绕过。 */
const CORE_IDS = new Set<string>(
  (() => {
    try {
      return readdirSync(join(rootDir, 'core'), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return []; // core/ 不可读属极端异常（内核自身也依赖它）；此时冲突校验退化为 id 格式校验
    }
  })(),
);

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** 默认骨架源码（Agent 不传 source 时生成；通常 Agent 会传入完整实现） */
function defaultSource(id: string, name: string): string {
  return `/**
 * plugins/${id}/index.ts —— 由 Agent 自我扩展创建（${name}）
 */
import type { Plugin } from '../../kernel/types';

export default {
  id: '${id}',
  name: '${name}',
  version: '0.1.0',
  onLoad(ctx) {
    ctx.register({
      kind: 'tool',
      tool: {
        name: '${id}_hello',
        description: '示例工具：返回问候语（可改成你的真实能力）',
        parameters: { type: 'object', properties: {} },
        async handler() {
          return { ok: true, data: 'hello from ${id}' };
        },
      },
    });
  },
} satisfies Plugin;
`;
}

interface RuntimeState {
  state: string;
  caps: string[];
  error?: string;
}

export default {
  id: 'self-extend',
  name: '自我扩展',
  version: '0.1.0',
  onLoad(ctx) {
    // ---- 通过总线事件跟踪插件加载状态（纯插件方案，不触碰内核） ----
    const runtime = new Map<string, RuntimeState>();
    ctx.on('plugin.registered', (e) => {
      const d = e.data as { id: string };
      if (d?.id) runtime.set(d.id, { state: 'registered', caps: [] });
    });
    ctx.on('plugin.loaded', (e) => {
      const d = e.data as { id: string; caps?: string[] };
      if (!d?.id) return;
      const s = runtime.get(d.id) ?? { state: '', caps: [] };
      s.state = 'loaded';
      s.caps = d.caps ?? [];
      runtime.set(d.id, s);
    });
    ctx.on('plugin.started', (e) => {
      const d = e.data as { id: string };
      if (!d?.id) return;
      const s = runtime.get(d.id) ?? { state: '', caps: [] };
      s.state = 'started';
      runtime.set(d.id, s);
    });
    ctx.on('plugin.stopped', (e) => {
      const d = e.data as { id: string };
      if (!d?.id) return;
      const s = runtime.get(d.id) ?? { state: '', caps: [] };
      s.state = 'stopped';
      runtime.set(d.id, s);
    });
    ctx.on('plugin.error', (e) => {
      // 注册期失败事件带 dir（目录名 = 插件 id），启动期失败带 id
      const d = e.data as { id?: string; dir?: string; error?: string };
      const id = d?.id ?? d?.dir;
      if (!id) return;
      const s = runtime.get(id) ?? { state: '', caps: [] };
      s.state = 'error';
      s.error = String(d.error ?? '未知错误');
      runtime.set(id, s);
    });
    ctx.on('plugin.unloaded', (e) => {
      const d = e.data as { id: string };
      if (d?.id) runtime.delete(d.id);
    });

    // ---- L2 人设：自我扩展规则（maharness 核心理念） ----
    ctx.register({
      kind: 'persona',
      persona: {
        id: 'self-extend-rules',
        name: '自我扩展规则（万物皆插件）',
        description: 'maharness 核心理念：agent 可以自己定义自己',
        priority: 20,
        content: [
          '自我扩展规则（maharness 核心理念：万物都是插件，你通过写插件来定义自己）：',
          '1. 需要新能力（新工具/新命令/事件监听）时，不要试图绕过限制，而是写一个新插件：用 create_plugin 生成（把完整 index.ts 源码放进 source 参数），或用 write_file 直接写 plugins/<id>/plugin.json 与 plugins/<id>/index.ts；',
          '2. 插件契约（务必遵守，否则加载失败或注册不上）：默认导出对象 { id, name, version, onLoad(ctx) }；onLoad 中用 ctx.register({ kind: "tool", tool: { name, description, parameters, handler } }) 注册工具；handler(args, tctx) 返回 { ok: true, data } 或 { ok: false, error }；类型定义用 import type { Plugin } from "../../kernel/types"；工具注册成功后在运行时可用。注意：不是 initialize/execute/success 那套旧写法；',
          '3. 创建后立即用 plugin_status 确认加载状态且 caps 非空；若 error 或 caps 为空，读取错误信息与插件文件，修复后保存（目录监听会自动重载），再验证；',
          '4. 插件目录名必须等于 id（小写字母/数字/连字符）；',
          '5. 新插件注册的工具在下一轮对话生效（本轮不能立即调用），完成后告知用户新能力已就绪；',
          '6. 修改边界：agent 运行时核心（kernel/ 与 core/chat 的执行循环）不可修改；core/ 其余内置插件与 ui/ 前端同属插件体系，可按需修改（core/ 改动经服务重启生效，ui/ 改动经前端构建生效）。',
        ].join('\n'),
      },
    });

    // ---- API 能力：贡献前端面板（前端是插件的一部分——插件可以定义自己的 UI 面板） ----
    ctx.register({
      kind: 'api',
      api: {
        mount: 'panel',
        router: ((req: { path?: string }, res: { json: (v: unknown) => void; status: (n: number) => { json: (v: unknown) => void } }) => {
          if (!req.path || req.path === '/' || req.path === '/panel') {
            res.json({
              title: '自我扩展 · 万物皆插件',
              html: `<div style="line-height:1.9">
                <p><b>maharness 积木哲学</b>：除了 agent 运行时核心，一切皆插件——包括你正在看的这个面板，就是由 self-extend 插件通过 <code>api</code> 能力提供的。</p>
                <ul style="padding-left:18px">
                  <li>需要新能力 → 用 <code>create_plugin</code> 现场编写插件</li>
                  <li>插件写在 <code>plugins/&lt;id&gt;/</code>，保存即热重载</li>
                  <li>插件可以注册工具、命令、人设、上下文，甚至 REST API 与前端面板</li>
                  <li>修改边界：内核不可动，其余皆可塑</li>
                </ul>
              </div>`,
            });
          } else {
            res.status(404).json({ error: '未知端点' });
          }
        }) as never,
      },
    });

    // ---- create_plugin：生成插件骨架并等待热加载结果 ----
    ctx.register({
      kind: 'tool',
      tool: {
        name: 'create_plugin',
        risk: 'high',
        costHint: 'medium',
        approval: true,
        limits: '写入 plugins/ 并热加载代码',
        description: '创建自我扩展插件：生成 plugin.json 与 index.ts 写入 plugins/ 现场目录，等待热加载后回传状态；失败时回传错误信息供修复。',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '插件 id：小写字母/数字/连字符，如 demo-clock' },
            name: { type: 'string', description: '插件显示名，如 时钟工具' },
            source: { type: 'string', description: 'index.ts 完整源码（可选；不传则生成正确的示例骨架）。契约：默认导出 { id, name, version, onLoad(ctx) }，onLoad 中用 ctx.register({ kind: "tool", tool: { name, description, parameters, handler } }) 注册；handler(args, tctx) 返回 { ok, data } 或 { ok, error }；类型 import type { Plugin } from "../../kernel/types"' },
          },
          required: ['id'],
        },
        async handler(args: { id?: string; name?: string; source?: string }, tctx: ToolContext) {
          const id = String(args.id ?? '').trim();
          const name = String(args.name ?? '').trim() || id;
          if (!id) return { ok: false, error: '缺少插件 id' };
          // id 校验（M8/M9）：先拦路径穿越，再拦非法字符，最后拦与内置插件冲突
          if (id.includes('..') || id.includes('/') || id.includes('\\')) {
            return { ok: false, error: '插件 id 非法：不允许路径穿越（含 ..、/、\\）' };
          }
          if (!PLUGIN_ID_RE.test(id)) return { ok: false, error: '插件 id 需为小写字母/数字/连字符且不超过 32 字符，如 demo-clock' };
          if (CORE_IDS.has(id)) return { ok: false, error: `id 与内置插件冲突: ${id}（core/ 目录内插件均不可覆盖）` };

          const dir = join(userPluginsDir, id);
          // 沙箱校验：plugins/ 必须位于沙箱根目录内（防御目录穿越）
          const rel = relative(tctx.sandboxRoot, dir);
          if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
            return { ok: false, error: '插件目录不在沙箱根目录内，已拒绝写入' };
          }
          if (existsSync(dir)) return { ok: false, error: `插件已存在: plugins/${id}（直接编辑其文件即可修改，勿重复创建）` };

          const source = typeof args.source === 'string' && args.source.trim() ? args.source : defaultSource(id, name);

          // 静态契约校验（启发式）：源码必须含核心契约要素，防止「假成功」插件
          const contractHints = ['onLoad', 'ctx.register', 'handler'];
          const missing = contractHints.filter((h) => !source.includes(h));
          if (missing.length) {
            return {
              ok: false,
              error: `源码不符合插件契约（缺少: ${missing.join(', ')}）。正确契约：默认导出 { id, name, version, onLoad(ctx) }；onLoad 中用 ctx.register({ kind: 'tool', tool: { name, description, parameters, handler } }) 注册工具；handler(args, tctx) 返回 { ok: true, data } 或 { ok: false, error }；类型定义用 import type { Plugin } from '../../kernel/types'。若不传 source，create_plugin 会生成正确的示例骨架。`,
            };
          }

          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ id, name, version: '0.1.0', entry: 'index.ts', enabled: true }, null, 2), 'utf8');
          writeFileSync(join(dir, 'index.ts'), source, 'utf8');

          // 等待热加载（目录监听防抖 500ms；最多等 3s；仅终态返回）
          const deadline = Date.now() + 3000;
          while (Date.now() < deadline) {
            const st = runtime.get(id);
            if (st && (st.state === 'started' || st.state === 'error' || st.state === 'stopped')) {
              if (st.state === 'started' && st.caps.length === 0) {
                // 加载成功但未注册任何能力 = 假成功：插件契约有误（如用了错误的生命周期/注册写法）
                return {
                  ok: false,
                  data: {
                    id, name, written: ['plugin.json', 'index.ts'], state: st.state,
                    caps: st.caps,
                    error: '插件已加载但未注册任何能力',
                    note: '检查 index.ts：必须用 onLoad(ctx) + ctx.register({ kind: "tool", tool: { name, description, parameters, handler } }) 注册；读取 plugins/<id>/index.ts 修正后保存会自动重载。',
                  },
                };
              }
              return {
                ok: st.state === 'started',
                data: {
                  id, name, written: ['plugin.json', 'index.ts'], state: st.state,
                  caps: st.caps,
                  error: st.error,
                  note: st.state === 'started'
                    ? '插件已加载，注册的能力在下一轮对话生效'
                    : '插件加载失败：读取 plugins/<id>/ 下文件，按错误信息修复后保存会自动重载',
                },
              };
            }
            await new Promise((r) => setTimeout(r, 150));
          }
          return {
            ok: true,
            data: {
              id, name, written: ['plugin.json', 'index.ts'], state: 'pending',
              note: '已写入 plugins/ 目录但未捕获到加载事件（目录监听可能不可用）。请用 plugin_status 确认，或在网页面板「插件」中手动重载。',
            },
          };
        },
      },
    });

    // ---- plugin_status：现场插件加载状态 ----
    ctx.register({
      kind: 'tool',
      tool: {
        name: 'plugin_status',
        risk: 'low',
        costHint: 'low',
        output: '{plugins: [{id, name, version, state, active, caps, error}]}；active=true 表示能力已在上下文可用',
        description: '查看 plugins/ 现场插件的状态。state 为机器态（started=运行中/loaded=已注册未激活/lazy=惰性声明/stopped=已停用/error=失败），' +
          'active 为语义判断（是否已进入上下文）：active=false 的插件需要 enable_plugin 激活后才能使用其能力。',
        parameters: { type: 'object', properties: {} },
        async handler() {
          const plugins: { id: string; name: string; version: string; state: string; active: boolean; caps: string[]; error?: string }[] = [];
          if (existsSync(userPluginsDir)) {
            for (const e of readdirSync(userPluginsDir, { withFileTypes: true })) {
              if (!e.isDirectory()) continue;
              const manifestPath = join(userPluginsDir, e.name, 'plugin.json');
              if (!existsSync(manifestPath)) continue;
              let manifest: Record<string, unknown> = {};
              try { manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')); } catch { /* 清单损坏按目录名兜底 */ }
              const id = String(manifest.id ?? e.name);
              const rt = runtime.get(id);
              const state = rt?.state ?? 'pending(未加载)';
              const active = rt?.state === 'started';
              plugins.push({
                id,
                name: String(manifest.name ?? id),
                version: String(manifest.version ?? ''),
                state,
                active,
                caps: rt?.caps ?? [],
                error: rt?.error,
              });
            }
          }
          plugins.sort((a, b) => a.id.localeCompare(b.id));
          return { ok: true, data: { dir: 'plugins/', count: plugins.length, plugins } };
        },
      },
    });

    // ---- 生命周期：dynamic capability loading（LLM 按需激活/停用插件，类似 OS 加载驱动） ----
    ctx.register({
      kind: 'tool',
      tool: {
        name: 'enable_plugin',
        risk: 'medium',
        costHint: 'low',
        approval: true,
        description: '激活一个插件（加载其能力进入上下文）。用于 lazy 声明或已停用的插件——' +
          '插件状态用 plugin_status 查看；激活后其工具/规则立即对后续对话生效。',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string', description: '插件 id（plugin_status 可查）' } },
          required: ['id'],
        },
        async handler(args: { id?: string }) {
          const id = String(args.id ?? '').trim();
          if (!id) return { ok: false, error: '缺少插件 id' };
          const inst = ctx.kernel.plugins.list().find((p) => p.manifest.id === id);
          if (!inst) return { ok: false, error: `插件不存在: ${id}（plugin_status 查看）` };
          try {
            await ctx.kernel.plugins.enable(id);
          } catch (err) {
            return { ok: false, error: `激活失败: ${err instanceof Error ? err.message : String(err)}` };
          }
          return { ok: true, data: { id, state: ctx.kernel.plugins.list().find((p) => p.manifest.id === id)?.state } };
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        name: 'disable_plugin',
        risk: 'medium',
        costHint: 'low',
        approval: true,
        description: '停用一个插件（卸载其能力与规则，能力从上下文消失）。用于不再需要的插件——' +
          '停用后其工具不再可用；可随时 enable_plugin 重新激活。',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string', description: '插件 id（plugin_status 可查）' } },
          required: ['id'],
        },
        async handler(args: { id?: string }) {
          const id = String(args.id ?? '').trim();
          if (!id) return { ok: false, error: '缺少插件 id' };
          const inst = ctx.kernel.plugins.list().find((p) => p.manifest.id === id);
          if (!inst) return { ok: false, error: `插件不存在: ${id}（plugin_status 查看）` };
          try {
            await ctx.kernel.plugins.disable(id);
          } catch (err) {
            return { ok: false, error: `停用失败: ${err instanceof Error ? err.message : String(err)}` };
          }
          return { ok: true, data: { id, state: ctx.kernel.plugins.list().find((p) => p.manifest.id === id)?.state } };
        },
      },
    });

    ctx.logger.info('工具就绪: create_plugin / plugin_status —— Agent 可以自己定义自己');
  },
} satisfies Plugin;
