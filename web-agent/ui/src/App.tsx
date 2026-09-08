// ui/src/App.tsx —— 主布局（Screen 1–8 导航枢纽）
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { approvalsApi, commandsApi, modelsApi, pluginsApi, providersApi, sessionApi, streamChat, subscribeEvents, traceApi } from './api';
import type { ApprovalItem, BusEvent, ChatMessage, CheckpointInfo, Message, ModelInfo, PlanState, PluginInfo, ProviderInfo, Session, TodoCard, TraceStep } from './types';
import Sidebar from './components/Sidebar';
import type { MainTab } from './components/Sidebar';
import ChatView from './components/ChatView';
import TracePanel from './components/TracePanel';
import Menu from './components/Menu';
import { AnimatePresence, motion } from 'motion/react';
import { pageVariants } from './motion';
import { IconChevronDown, IconClose, IconPanel, IconWorkbench } from './components/Icon';
import { Toaster, toast } from 'sonner';
import { applyFavicon } from './brand/favicon';

// 次要视图路由级代码分割：首屏只需 Chat 视图，文件/工作台/插件/统计/设置
// 按需加载（首屏 JS 体积显著下降），挂载后 idle 时预取保证首次点击无感
const FilesView = lazy(() => import('./components/FilesView'));
const WorkbenchView = lazy(() => import('./components/WorkbenchView'));
const PluginsView = lazy(() => import('./components/PluginsView'));
const StatsView = lazy(() => import('./components/StatsView'));
const SettingsView = lazy(() => import('./components/SettingsView'));

function preloadSecondaryViews() {
  void import('./components/FilesView');
  void import('./components/WorkbenchView');
  void import('./components/PluginsView');
  void import('./components/StatsView');
  void import('./components/SettingsView');
}

/** 模型条目 id = provider@model（服务端 /api/models 约定） */
function splitModelId(id: string): { provider: string; model: string } {
  const i = id.lastIndexOf('@');
  return i > 0 ? { provider: id.slice(0, i), model: id.slice(i + 1) } : { provider: id, model: '' };
}

export type Theme = 'dark' | 'light';
export type Brand = 'doodle' | 'ink' | 'moss';

function readTheme(): Theme {
  try {
    const saved = localStorage.getItem('maharness-theme');
    if (saved === 'dark' || saved === 'light') return saved;
  } catch { /* 隐私模式等场景读不到 */ }
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function readBrand(): Brand {
  try {
    const b = localStorage.getItem('maharness-brand');
    if (b === 'ink' || b === 'moss' || b === 'doodle') return b;
  } catch { /* 忽略 */ }
  return 'doodle';
}

export default function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [sel, setSel] = useState<{ provider: string; model: string } | null>(null);
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [activeTab, setActiveTab] = useState<MainTab>('chat');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [traceSteps, setTraceSteps] = useState<TraceStep[]>([]);
  const [traceStats, setTraceStats] = useState<{ trace: Record<string, number>; cache: Record<string, number>; l1Enabled: boolean } | null>(null);
  const [traceOpen, setTraceOpen] = useState(true);
  const [approvals, setApprovals] = useState<ApprovalItem[]>([]);
  const [plan, setPlan] = useState<PlanState | null>(null);
  const [todos, setTodos] = useState<TodoCard[]>([]); // todo 插件：待办看板/模型 to do list（全量，按会话过滤展示）
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [brand, setBrand] = useState<Brand>(readBrand);
  // 会话状态感知（agent harness 前端特征）：断点可恢复 / 角色接管 / 成本熔断
  const [checkpoint, setCheckpoint] = useState<CheckpointInfo | null>(null);
  const [resuming, setResuming] = useState(false);
  const [budgetHit, setBudgetHit] = useState<{ cost: number; budget: number } | null>(null);
  // 会话累计成本（composer 区域实时显示：harness 管理认知资源的可见性）
  const [sessionCost, setSessionCost] = useState(0);
  // provider 重试（retry）截断标记：流式消息从 retry 边界起显示，等价「清空重累积」。
  // 标记由 App 记录（rAF 合帧缓冲的持有方，retry 时刻能算出含未冲刷增量的精确长度）
  const [retryMarks, setRetryMarks] = useState<Record<string, { content: number; reasoning: number }>>({});

  const abortRef = useRef<AbortController | null>(null);
  // 消息镜像 ref：retry 时刻同步读取（state 提交前也能拿到当前值）
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // ---- 流式文本 rAF 合帧缓冲 ----
  // SSE 每 chunk 一次 setState 会让 App 整树以 chunk 频率全量重渲染（长会话下明显卡顿）。
  // 增量先累积进缓冲，requestAnimationFrame 每帧只提交一次——渲染频率 ≤ 显示器刷新率，
  // 输入法/滚动等交互不再被流式输出抢占主线程。
  const pendingStreamRef = useRef<{ id: string; content: string; reasoning: string } | null>(null);
  const streamRafRef = useRef(0);

  const flushStreamBuffer = useCallback(() => {
    if (streamRafRef.current) { cancelAnimationFrame(streamRafRef.current); streamRafRef.current = 0; }
    const p = pendingStreamRef.current;
    if (!p) return;
    pendingStreamRef.current = null;
    setMessages((prev) => prev.map((m) => m.id === p.id
      ? { ...m, content: m.content + p.content, reasoning: (m.reasoning ?? '') + p.reasoning }
      : m));
  }, []);

  const queueStreamText = useCallback((id: string, patch: { content?: string; reasoning?: string }) => {
    const p = pendingStreamRef.current;
    if (p && p.id === id) {
      if (patch.content) p.content += patch.content;
      if (patch.reasoning) p.reasoning += patch.reasoning;
    } else {
      if (p) flushStreamBuffer(); // 换消息前冲刷旧缓冲（正常时序下不会发生）
      pendingStreamRef.current = { id, content: patch.content ?? '', reasoning: patch.reasoning ?? '' };
    }
    if (!streamRafRef.current) {
      streamRafRef.current = requestAnimationFrame(() => { streamRafRef.current = 0; flushStreamBuffer(); });
    }
  }, [flushStreamBuffer]);

  // 主题：写 dataset + localStorage + Sonner 主题同步（首帧由 main.tsx 预置，避免闪烁）
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.setAttribute('data-sonner-theme', theme);
    // 浏览器窗口 chrome（标题栏/状态栏）跟随明暗主题
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#161411' : '#f5eee0');
    applyFavicon(theme);
    try { localStorage.setItem('maharness-theme', theme); } catch { /* 忽略 */ }
  }, [theme]);

  // 品牌色板预设（与明暗正交）：写 dataset + localStorage，并让 favicon 取新主色
  useEffect(() => {
    document.documentElement.dataset.brand = brand;
    try { localStorage.setItem('maharness-brand', brand); } catch { /* 忽略 */ }
    applyFavicon(theme);
  }, [brand, theme]);

  // 供应商被删除后清理当前选择（防止已删除的 provider 残留在模型下拉/会话里）
  useEffect(() => {
    if (sel?.provider && !providers.some((p) => p.id === sel.provider)) {
      setSel(models.length ? splitModelId(models[0].id) : null);
    }
    // 仅在 providers 变化时校正；sel 变化不触发，避免抖动
  }, [providers]);

  // 初始加载
  useEffect(() => { void loadAll(); }, []);

  // 全局事件订阅：trace.step 仅在轨迹面板打开时入库——面板关闭时逐事件 setState
  // 会让整个 App 树空转重渲染（流式运行时每秒可达数十次）
  const traceOpenRef = useRef(traceOpen);
  traceOpenRef.current = traceOpen;
  useEffect(() => {
    const off = subscribeEvents((e: BusEvent) => {
      if (e.type === 'trace.step') {
        if (traceOpenRef.current) setTraceSteps((prev) => [...prev.slice(-199), e.data as TraceStep]);
      }
      else if (e.type === 'plan.updated') setPlan(e.data as PlanState | null);
      else if (e.type === 'todo.updated') setTodos((e.data as { cards: TodoCard[] } | null)?.cards ?? []);
      else if (e.type === 'approval.requested') {
        // 子代理/并行任务的审批经全局事件广播（主执行器阻塞在子任务 handler 内，
        // 审批事件无法从其 SSE 流到达）；按 id 去重合并进统一审批列表
        const d = e.data as { approvalId: string; name: string; summary: string };
        if (d?.approvalId) {
          setApprovals((prev) => (prev.some((a) => a.id === d.approvalId) ? prev : [...prev, { id: d.approvalId, name: d.name, summary: d.summary }]));
        }
      }
    });
    return () => { off(); };
  }, []);

  // trace 统计轮询：只在轨迹面板可见时进行（关面板 = 零后台请求）
  useEffect(() => {
    if (!traceOpen || activeTab !== 'chat') return;
    void traceApi.stats().then(setTraceStats).catch(() => undefined);
    const t = setInterval(() => { void traceApi.stats().then(setTraceStats).catch(() => undefined); }, 2000);
    return () => clearInterval(t);
  }, [traceOpen, activeTab]);

  // 次要视图 chunk 预取：首屏渲染完成后 idle 时拉取，首次切 Tab 无加载等待
  useEffect(() => {
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(preloadSecondaryViews, { timeout: 2500 });
      return () => window.cancelIdleCallback(id);
    }
    const t = window.setTimeout(preloadSecondaryViews, 1500);
    return () => window.clearTimeout(t);
  }, []);

  async function loadAll() {
    try {
      const [ss, ms, pl, pvs] = await Promise.all([sessionApi.list(), modelsApi.list(), pluginsApi.list(), providersApi.list()]);
      setSessions(ss);
      setModels(ms);
      setPlugins(pl);
      setProviders(pvs);
      if (ms.length) setSel((prev) => {
        if (prev) return prev;
        // 优先用第一个会话保存的 provider + model（如果该 provider 存在且该模型属于它）
        const firstSession = ss[0];
        if (firstSession?.provider && firstSession.model) {
          const m = ms.find((x) => x.provider === firstSession.provider && x.model === firstSession.model);
          if (m) return { provider: m.provider, model: m.model };
          const any = ms.find((x) => x.provider === firstSession.provider);
          if (any) return { provider: any.provider, model: any.model };
        }
        return splitModelId(ms[0].id);
      });
      let initialId: string | null = null;
      if (!ss.length) {
        const created = await sessionApi.create(ms[0]?.model ?? '');
        setSessions([created]);
        initialId = created.id;
      } else {
        initialId = ss[0].id;
      }
      // 初始会话：同步加载历史消息，避免首屏空白
      setActiveId(initialId);
      if (initialId) {
        try {
          const msgs = await sessionApi.messages(initialId);
          setMessages(msgs.filter((m): m is Message & { role: 'user' | 'assistant' } => m.role === 'user' || m.role === 'assistant').map((m) => ({ id: m.id, role: m.role, content: m.content ?? '', reasoning: m.reasoning })));
        } catch { /* 忽略 */ }
      }
    } catch (err) {
      console.error('[maharness] 初始加载失败:', err);
      toast.error(`初始加载失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const selectSession = useCallback(async (id: string) => {
    setActiveId(id);
    setMessages([]);
    setTraceSteps([]);
    setPlan(null);
    setCheckpoint(null);
    setBudgetHit(null);
    setSessionCost(0);
    try {
      const [msgs, cp] = await Promise.all([sessionApi.messages(id), sessionApi.checkpoint(id).catch(() => null)]);
      setMessages(msgs.filter((m): m is Message & { role: 'user' | 'assistant' } => m.role === 'user' || m.role === 'assistant').map((m) => ({ id: m.id, role: m.role, content: m.content ?? '', reasoning: m.reasoning })));
      setCheckpoint(cp);
      setSessionCost(msgs.reduce((s, m) => s + (m.cost ?? 0), 0));
    } catch (err) {
      toast.error(`加载会话失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [toast]);

  const createSession = useCallback(async () => {
    try {
      const s = await sessionApi.create(sel?.model ?? '');
      setSessions((prev) => [s, ...prev]);
      setActiveId(s.id);
      setMessages([]);
      setTraceSteps([]);
      setPlan(null);
      setCheckpoint(null);
      setBudgetHit(null);
      setSessionCost(0);
      toast.success('已创建新会话');
    } catch (err) {
      toast.error(`新建会话失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [sel, toast]);

  const deleteSession = useCallback(async (id: string) => {
    try {
      await sessionApi.remove(id);
    } catch (err) {
      toast.error(`删除会话失败：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    toast.success('会话已删除');
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id);
      if (activeId === id) {
        if (next.length) void selectSession(next[0].id);
        else { setActiveId(null); setMessages([]); }
      }
      return next;
    });
  }, [activeId, selectSession, toast]);

  const archiveSession = useCallback(async (id: string, archived: boolean) => {
    try {
      await sessionApi.update(id, { archived });
      setSessions(await sessionApi.list());
      toast.success(archived ? '会话已归档' : '会话已取消归档');
    } catch (err) {
      toast.error(`归档操作失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [toast]);

  const pinSession = useCallback(async (id: string, pinned: boolean) => {
    try {
      await sessionApi.update(id, { pinned });
      setSessions(await sessionApi.list());
      toast.success(pinned ? '会话已置顶' : '会话已取消置顶');
    } catch (err) {
      toast.error(`置顶操作失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [toast]);

  /** 批量删除（后端事务原子批量接口） */
  const batchDelete = useCallback(async (ids: string[]) => {
    if (!ids.length) return;
    try {
      const r = await sessionApi.batchRemove(ids);
      setSessions(await sessionApi.list());
      if (activeId && ids.includes(activeId)) {
        const next = sessions.filter((s) => !ids.includes(s.id));
        if (next.length) void selectSession(next[0].id);
        else { setActiveId(null); setMessages([]); setTraceSteps([]); setPlan(null); }
      }
      toast.success(`已删除 ${r.removed ?? ids.length} 个会话`);
    } catch (err) {
      toast.error(`批量删除失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [activeId, sessions, selectSession, toast]);

  /** 批量归档（未归档的标记归档） */
  const batchArchive = useCallback(async (ids: string[]) => {
    if (!ids.length) return;
    try {
      for (const id of ids) await sessionApi.update(id, { archived: true });
      setSessions(await sessionApi.list());
      toast.success(`已归档 ${ids.length} 个会话`);
    } catch (err) {
      toast.error(`批量归档失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [toast]);

  const renameSession = useCallback(async (id: string, title: string) => {
    const t = title.trim();
    if (!t) return;
    try {
      await sessionApi.rename(id, t);
      setSessions(await sessionApi.list());
      toast.success('会话已重命名');
    } catch (err) {
      toast.error(`重命名失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [toast]);

  const setSessionMode = useCallback(async (mode: string) => {
    if (!activeId) return;
    try {
      await sessionApi.update(activeId, { mode });
      setSessions((prev) => prev.map((s) => s.id === activeId ? { ...s, mode } : s));
      const label = mode === 'plan' ? '计划模式' : mode === 'goal' ? '目标模式' : '普通模式';
      toast.success(`已切换到${label}`);
    } catch (err) {
      toast.error(`切换模式失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [activeId, toast]);

  const selectModel = useCallback(async (id: string) => {
    // 兼容两种 key：新格式 `provider@model`；旧格式纯 provider id（浏览器缓存旧 UI 时）
    let x = splitModelId(id);
    if (!x.model) {
      const first = models.find((m) => m.provider === id || m.id === id);
      if (!first) return;
      x = { provider: first.provider, model: first.model };
    }
    setSel(x);
    if (activeId) {
      try {
        await sessionApi.update(activeId, { model: x.model, provider: x.provider });
      }
      catch (err) { toast.error(`模型切换失败：${err instanceof Error ? err.message : String(err)}`); }
    }
  }, [models, activeId, toast]);

  const pluginAction = useCallback(async (id: string, action: 'enable' | 'disable' | 'reload' | 'uninstall') => {
    try {
      const r = await pluginsApi.action(id, action);
      setPlugins(await pluginsApi.list());
      const label = action === 'enable' ? '已启用' : action === 'disable' ? '已停用' : action === 'uninstall' ? '已卸载' : '已重载';
      toast.success(`${label}（${id} · ${r.state}）`);
    } catch (err) {
      const label = action === 'enable' ? '启用' : action === 'disable' ? '停用' : action === 'uninstall' ? '卸载' : '重载';
      toast.error(`插件${label}失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [toast]);

  const refreshProviders = useCallback(async () => {
    try {
      setProviders(await providersApi.list());
      setModels(await modelsApi.list());
    } catch (err) {
      toast.error(`刷新 Provider 失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [toast]);

  /** 流式回复处理器（send 与断点续跑共用；文本增量经 rAF 合帧批量提交） */
  const makeStreamHandlers = useCallback((assistantId: string) => ({
    onStart: () => {},
    onDelta: (t: string) => queueStreamText(assistantId, { content: t }),
    onReasoning: (t: string) => queueStreamText(assistantId, { reasoning: t }),
    onToolStart: (name: string, args: unknown) => {
      flushStreamBuffer();
      setMessages((prev) => prev.map((m) => m.id === assistantId ? { ...m, tools: [...(m.tools ?? []), { name, args, status: 'running' as const, startedAt: Date.now() }] } : m));
    },
    onToolResult: (name: string, summary: string, ok: boolean, stored?: boolean) => {
      flushStreamBuffer();
      setMessages((prev) => prev.map((m) => m.id === assistantId ? {
        ...m, tools: (m.tools ?? []).map((t) => t.name === name && t.status === 'running' ? {
          ...t, summary, ok, stored, status: ok ? 'done' as const : 'error' as const, durationMs: Date.now() - (t.startedAt ?? Date.now()),
        } : t),
      } : m));
    },
    onApprovalRequired: (id: string, name: string, summary: string) => setApprovals((prev) => prev.some((a) => a.id === id) ? prev : [...prev, { id, name, summary }]),
    onHandoff: (role: string, objective: string) => {
      // 角色移交：消息流插入系统通知；会话角色由后端持久化（刷新列表同步）
      flushStreamBuffer();
      setMessages((prev) => [...prev, { id: `ho-${Date.now()}`, role: 'system', content: `已移交给「${role}」角色：${objective.slice(0, 120)}` }]);
      void sessionApi.list().then(setSessions).catch(() => undefined);
    },
    onBudgetHit: (cost: number, budget: number) => {
      // 成本熔断：横幅展示（harness 硬边界）
      setBudgetHit({ cost, budget });
    },
    onRetry: () => {
      // provider 重试：记录截断边界（含未冲刷增量），流式消息从该边界起重新累积展示
      const p = pendingStreamRef.current;
      const base = messagesRef.current.find((m) => m.id === assistantId);
      const pending = p?.id === assistantId ? p : null;
      setRetryMarks((prev) => ({ ...prev, [assistantId]: {
        content: (base?.content.length ?? 0) + (pending?.content.length ?? 0),
        reasoning: (base?.reasoning?.length ?? 0) + (pending?.reasoning.length ?? 0),
      } }));
    },
    onDone: (d: { content: string; reasoning?: string; usage: { input: number; output: number }; cost: number; cached?: boolean }) => {
      flushStreamBuffer();
      setMessages((prev) => prev.map((m) => m.id === assistantId ? { ...m, content: d.content, reasoning: d.reasoning ?? m.reasoning, streaming: false, usage: d.usage, cost: d.cost, cached: d.cached } : m));
      setSessionCost((prev) => prev + (d.cost ?? 0));
    },
    onError: (e: string) => {
      flushStreamBuffer(); // 失败前已生成的部分内容保留可见
      setMessages((prev) => prev.map((m) => m.id === assistantId ? { ...m, streaming: false, error: e } : m));
      // 错误结束（如超轮数/熔断/连接中断）→ 同步断点：未完成任务保留「继续任务」入口；
      // 同时复位全局 streaming——错误路径可能没有后续 'end' 事件（传输层断开），
      // 不复位则输入区与停止按钮锁死在 streaming 状态
      setStreaming(false);
      if (activeId) void sessionApi.checkpoint(activeId).then(setCheckpoint).catch(() => undefined);
    },
    onEnd: () => {
      flushStreamBuffer();
      setStreaming(false);
      // 任务正常完成 → 后端已清除断点
      setCheckpoint(null);
      setSessions((prev) => prev.map((s) => s.id === activeId ? { ...s, updatedAt: Date.now() } : s));
    },
  }), [activeId, queueStreamText, flushStreamBuffer]);

  const send = useCallback(async (text: string) => {
    if (!activeId || !text.trim() || streaming) return;

    if (text.trim().startsWith('/')) {
      const systemMsg = (content: string) => setMessages((prev) => [...prev, { id: `cmd-${Date.now()}`, role: 'system', content }]);
      try {
        const r = await commandsApi.exec(text.trim(), activeId);
        if (r.type === 'message') {
          systemMsg(r.data?.text ?? '');
        } else if (r.type === 'action') {
          const a = r.data?.action;
          if (a === 'new_session') await createSession();
          else if (a === 'clear') setMessages([]);
          else if (a === 'set_mode') {
            const mode = r.data?.mode ?? 'normal';
            setSessions((prev) => prev.map((s) => s.id === activeId ? { ...s, mode } : s));
            systemMsg(`已切换到${mode === 'plan' ? '计划模式' : mode === 'goal' ? '目标模式' : '普通模式'}（影响后续对话）`);
          } else if (a === 'set_model') {
            setSel({ provider: r.data?.provider ?? '', model: r.data?.model ?? '' });
            systemMsg(`模型已切换：${r.data?.model ?? ''}`);
          }
        } else if (!r.ok) {
          systemMsg(`⚠ ${r.error ?? '命令执行失败'}`);
        }
      } catch (err) {
        systemMsg(`⚠ ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    const userMsg: ChatMessage = { id: `u-${Date.now()}`, role: 'user', content: text };
    const assistantMsg: ChatMessage = { id: `a-${Date.now()}`, role: 'assistant', content: '', streaming: true, tools: [] };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setRetryMarks({});
    setStreaming(true);
    const ac = new AbortController();
    abortRef.current = ac;

    await streamChat(activeId, { message: text, model: sel?.model ?? '' }, makeStreamHandlers(assistantMsg.id), ac.signal);

    try { setSessions(await sessionApi.list()); } catch { /* 会话列表刷新失败不影响本次回复 */ }
  }, [activeId, sel, streaming, createSession, makeStreamHandlers]);

  /** 断点续跑（checkpoint）：从上次中断的轮次继续，复用完整对话流程 */
  const resumeTask = useCallback(async () => {
    if (!activeId || streaming || resuming) return;
    const cp = checkpoint;
    if (!cp?.exists) return;
    setResuming(true);
    // 恢复期间置全局 streaming：输入区防重入（可再点发送会撞服务端 409）与
    // 停止按钮可用——恢复任务同样可被用户中断
    setStreaming(true);
    const assistantMsg: ChatMessage = { id: `a-${Date.now()}`, role: 'assistant', content: '', streaming: true, tools: [] };
    setMessages((prev) => [...prev, { id: `cp-${Date.now()}`, role: 'system', content: `任务曾中断于第 ${cp.turn + 1} 轮——正在从断点继续…` }, assistantMsg]);
    setCheckpoint(null);
    const ac = new AbortController();
    abortRef.current = ac;
    await streamChat(activeId, { resume: true, model: sel?.model ?? '', provider: sel?.provider }, makeStreamHandlers(assistantMsg.id), ac.signal);
    setResuming(false);
    try {
      const cp2 = await sessionApi.checkpoint(activeId).catch(() => null);
      setCheckpoint(cp2); // 恢复后若再次中断（如熔断），断点仍可继续
      setSessions(await sessionApi.list());
    } catch { /* 忽略 */ }
  }, [activeId, streaming, resuming, checkpoint, sel, makeStreamHandlers]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setMessages((prev) => prev.map((m) => m.streaming ? { ...m, streaming: false } : m));
    setStreaming(false);
    // 中断后同步断点状态：任务未完成 → 立即显示「继续任务」横幅（无需刷新页面）
    if (activeId) void sessionApi.checkpoint(activeId).then(setCheckpoint).catch(() => undefined);
  }, [activeId]);

  const respondApproval = useCallback(async (id: string, approved: boolean) => {
    try {
      await approvalsApi.respond(id, approved);
      toast.success(approved ? '已批准执行' : '已拒绝');
    } catch {
      toast.error('审批已过期或无效');
    }
    setApprovals((prev) => prev.filter((a) => a.id !== id));
  }, [toast]);

  // 稳定引用回调：配合 memo 化的 Sidebar/TracePanel，流式渲染期间跳过无关子树 reconcile
  const handleRoleReset = useCallback(async () => {
    if (!activeId) return;
    try {
      await sessionApi.update(activeId, { role: '' });
      setSessions(await sessionApi.list());
      toast.success('会话已交回主代理');
    } catch (err) {
      toast.error(`移交失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [activeId, toast]);

  const refreshTraceStats = useCallback(() => {
    void traceApi.stats().then(setTraceStats).catch(() => undefined);
  }, []);

  const toggleSettings = useCallback(() => setSettingsOpen((v) => !v), []);

  const currentSession = sessions.find((s) => s.id === activeId);
  const pluginRunning = plugins.filter((p) => p.state === 'started' || p.state === 'loaded').length;
  const modeLabel = currentSession?.mode === 'plan' ? '计划模式' : currentSession?.mode === 'goal' ? '目标模式' : '普通模式';
  const modeColor = currentSession?.mode === 'plan' ? 'var(--purple)' : currentSession?.mode === 'goal' ? 'var(--orange)' : 'var(--text-3)';
  const selModel = sel ? models.find((m) => m.id === `${sel.provider}@${sel.model}`) : undefined;
  const modelLabel = selModel ? `${selModel.label} · ${selModel.model}` : (sel?.model ? `${sel.provider} · ${sel.model}` : '');
  const modelTag = selModel?.model ?? sel?.model ?? '';
  const modeItems = [
    { key: 'normal', label: '普通模式', sub: '自由对话', dot: 'var(--text-3)' },
    { key: 'plan', label: '计划模式', sub: '先出计划再执行', dot: 'var(--purple)' },
    { key: 'goal', label: '目标模式', sub: '以目标驱动多轮', dot: 'var(--orange)' },
  ];

  // 办公工作台（workbench 插件）：插件运行中才挂 Tab——插件停用/热重载中即从主导航消失，
  // 正停留在该 Tab 时自动回落到会话页（随时可关停，不影响原功能）
  const workbenchReady = plugins.some((p) => p.id === 'workbench' && (p.state === 'started' || p.state === 'loaded'));
  const pluginTabs = useMemo(() => (
    workbenchReady ? [{ key: 'workbench', label: '工作台', icon: <IconWorkbench size={14} /> }] : []
  ), [workbenchReady]);
  useEffect(() => {
    if (!workbenchReady && activeTab === 'workbench') setActiveTab('chat');
  }, [workbenchReady, activeTab]);

  const onTab = useCallback((t: MainTab) => {
    setActiveTab(t);
    setSettingsOpen(false);
  }, []);

  // Suspense 兜底（lazy 视图 chunk 加载间隙）：与设计系统一致的极简加载态。
  // 注意：边界必须包在 AnimatePresence 外面——mode="wait" 不支持会挂起的新子树
  // （挂起会卡住交换，旧视图停留在透明退出态，内容"消失"）
  const viewFallback = (
    <div className="view-loading" aria-busy="true">
      <span className="spin" style={{ color: 'var(--accent)' }} />
      <span>加载中…</span>
    </div>
  );

  return (
    <div className="app">
      <Sidebar
        sessions={sessions}
        activeId={activeId}
        activeTab={activeTab}
        onTab={onTab}
        pluginTabs={pluginTabs}
        onSelect={selectSession}
        onCreate={createSession}
        onDelete={deleteSession}
        onArchive={archiveSession}
        onPin={pinSession}
        onRename={renameSession}
        onBatchDelete={batchDelete}
        onBatchArchive={batchArchive}
        settingsOpen={settingsOpen}
        onToggleSettings={toggleSettings}
        pluginRunning={pluginRunning}
      />

      <main className="main">
        <header className="topbar">
          <div className="topbar-left">
            <div className="crumb">
              <span className="prev">DEEPSEEK</span>
              <span className="sep">/</span>
              <span className="cur">{activeTab === 'chat' ? (currentSession?.title ?? '新会话') : activeTab === 'files' ? '文件工作区' : activeTab === 'workbench' ? '办公工作台' : activeTab === 'plugins' ? '插件管理' : '缓存与成本'}</span>
            </div>
          </div>
          <div className="topbar-right">
            {activeTab === 'chat' && (
              <>
                <Menu
                  trigger={<><span className="mode-dot" style={{ background: modeColor }} />{modeLabel}<IconChevronDown size={11} /></>}
                  items={modeItems}
                  selectedKey={currentSession?.mode ?? 'normal'}
                  onSelect={(k) => void setSessionMode(k)}
                  title="会话模式"
                  width={220}
                  triggerTitle="会话模式"
                />
                <Menu
                  trigger={<>{modelLabel || '未选择模型'}<IconChevronDown size={11} /></>}
                  items={models.map((m) => ({ key: m.id, label: m.label, sub: m.model }))}
                  selectedKey={sel ? `${sel.provider}@${sel.model}` : undefined}
                  onSelect={(k) => void selectModel(k)}
                  title="切换模型"
                  width={280}
                  triggerTitle="切换模型"
                  disabled={models.length === 0}
                />
                <button
                  className={`tb-icon-btn ${traceOpen ? 'active' : ''}`}
                  onClick={() => setTraceOpen((v) => !v)}
                  title="运行轨迹面板"
                  aria-label="运行轨迹面板"
                >
                  {traceOpen ? <IconClose size={14} /> : <IconPanel size={15} />}
                </button>
              </>
            )}
            {activeTab !== 'chat' && <span className="tb-live"><span className="live-dot" />实时</span>}
          </div>
        </header>

        <Suspense fallback={viewFallback}>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            className="tab-content"
            key={settingsOpen ? 'settings' : activeTab}
            variants={pageVariants}
            initial="initial"
            animate="enter"
            exit="exit"
          >
          {settingsOpen ? (
            <SettingsView providers={providers} onChanged={refreshProviders} theme={theme} onThemeChange={setTheme} brand={brand} onBrandChange={setBrand} />
          ) : activeTab === 'chat' ? (
            <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <ChatView
                  messages={messages}
                  streaming={streaming}
                  onSend={send}
                  onStop={stop}
                  hasModels={models.length > 0}
                  approvals={approvals}
                  onApproval={respondApproval}
                  plan={plan}
                  todos={todos.filter((t) => !t.sessionId || t.sessionId === currentSession?.id)}
                  modelLabel={modelLabel}
                  modelTag={modelTag}
                  models={models}
                  onSelectModel={(k) => void selectModel(k)}
                  selectedModelId={sel ? `${sel.provider}@${sel.model}` : undefined}
                  retryMarks={retryMarks}
                  // 会话状态感知（agent harness 前端特征）：断点恢复 / 角色接管 / 成本熔断 / 会话成本
                  checkpoint={checkpoint}
                  onResume={() => void resumeTask()}
                  resuming={resuming}
                  role={currentSession?.role}
                  onRoleReset={handleRoleReset}
                  budgetHit={budgetHit}
                  sessionCost={sessionCost}
                />
              </div>
              {traceOpen && (
                <aside className="trail-panel">
                  <TracePanel
                    steps={traceSteps}
                    stats={traceStats}
                    onRefresh={refreshTraceStats}
                  />
                </aside>
              )}
            </div>
          ) : activeTab === 'files' ? (
            <FilesView />
          ) : activeTab === 'workbench' ? (
            <WorkbenchView />
          ) : activeTab === 'plugins' ? (
            <PluginsView plugins={plugins} onAction={pluginAction} />
          ) : (
            <StatsView />
          )}
          </motion.div>
        </AnimatePresence>
        </Suspense>
      </main>

      <Toaster
        theme={theme}
        richColors
        position="bottom-right"
        gap={8}
        visibleToasts={4}
        toastOptions={{
          style: {
            background: 'var(--bg-elev)',
            border: '1px solid var(--border)',
            color: 'var(--text-1)',
            fontFamily: 'var(--font-sans)',
            fontSize: '12.5px',
            boxShadow: 'var(--shadow-pop)',
          },
          classNames: {
            success: 'sonner-toast-success',
            error: 'sonner-toast-error',
            info: 'sonner-toast-info',
          },
        }}
      />
    </div>
  );
}
