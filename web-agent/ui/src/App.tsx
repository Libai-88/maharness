import type { MaterialRef } from './material-api';
import { activeRun, runsApi, type RunInfo } from './run-api';
import { subscribeRun } from './api';
// ui/src/App.tsx —— 应用状态协调器
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { commandsApi, modelsApi, navApi, planApi, pluginsApi, providersApi, sessionApi, streamChat, subscribeEvents, traceApi } from './api';
import { useApprovals } from './hooks/useApprovals';
import { useTraceSteps } from './hooks/useTraceSteps';
import type { ErrorKind } from './api';
import type { BusEvent, ChatMessage, CheckpointInfo, ModelInfo, PlanState, PluginDiagnostic, PluginInfo, PluginNavItem, ProviderInfo, Session, TaskVerificationInfo, TodoCard, ToolEvidence, ToolWarning, TraceStep } from './types';
import { toolActivityLabel } from './types';
// 演出重建：DB 行 → 界面消息（刷新前后同一形态）；文案中心：所有系统话术统一出口
import { collectMembers, replayMessages } from './replay';
import { humanizeError, sys } from './voice';

/** 切到后台时的消息提醒：标题角标 + 一声轻响（像微信的消息音） */
let audioCtxRef: AudioContext | null = null;
function dingOnce() {
  try {
    const AC = window.AudioContext;
    if (!AC) return;
    if (!audioCtxRef) audioCtxRef = new AC();
    const ctx = audioCtxRef;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g);
    g.connect(ctx.destination);
    o.type = 'sine';
    o.frequency.setValueAtTime(880, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(660, ctx.currentTime + 0.35);
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.05, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.45);
    o.start();
    o.stop(ctx.currentTime + 0.5);
  } catch { /* 音频不可用时静默 */ }
}
import type { MainTab } from './components/Sidebar';
import { Blocks, ClipboardCheck, BriefcaseBusiness } from 'lucide-react';
import { toast } from 'sonner';
import { applyFavicon } from './brand/favicon';
import AppView from './components/AppView';

// 次要视图路由级代码分割：首屏只需 Chat 视图，文件/插件/统计/设置
// 按需加载（首屏 JS 体积显著下降），挂载后 idle 时预取保证首次点击无感。
// 注意：插件页面【不在】此列表——它们由插件在 plugin.json 声明 nav，
// 前端遍历 /api/nav 生成标签页，内容由 PluginTabView 通用渲染（前端不认识任何插件）。
function preloadSecondaryViews() {
  void import('./components/FilesView');
  void import('./components/PluginsView');
  void import('./components/StatsView');
  void import('./components/SettingsView');
}

/**
 * 插件图标解析：nav.icon 是插件声明的图标名，这里是前端内置图标表。
 * 未知名回落到通用插件图标——插件写错图标名不该导致它的页面无法使用。
 */
function pluginIcon(name: string | null): React.ReactNode {
  switch (name) {
    case 'workbench': return <BriefcaseBusiness size={14} />;
    case 'todo': return <ClipboardCheck size={14} />;
    default: return <Blocks size={14} />;
  }
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
  const [pluginDiagnostics, setPluginDiagnostics] = useState<PluginDiagnostic[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [activeTab, setActiveTab] = useState<MainTab>('chat');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { steps: traceSteps, open: traceOpen, setOpen: setTraceOpen, record: recordTraceStep, clear: clearTraceSteps } = useTraceSteps();
  const [traceStats, setTraceStats] = useState<{ trace: Record<string, number>; cache: Record<string, number>; l1Enabled: boolean } | null>(null);
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
  // provider 重试的截断边界现在挂在消息自身（ChatMessage.retryFrom）——
  // 旧的并行 Record 会随会话数无限增长，且与消息生命周期不同步。
  // 前置重活（历史压缩等）的播报文本：让"开口前的十几秒"有话说，而不是干等
  const [streamStatus, setStreamStatus] = useState<string | null>(null);
  const [pendingInference, setPendingInference] = useState<{ objective: string; rationale: string; confidence: number } | null>(null);
  useEffect(() => { setPendingInference(null); }, [activeId]);
  // 与后端的常驻事件连接状态：断了要看得见（旧版"实时"灯常亮，数据其实早就不动了）
  const [liveState, setLiveState] = useState<'open' | 'down'>('open');
  // 并行小队进度（parallel.progress 广播）：按会话归集，渲染成"小队"气泡上的进度行。
  // 旧版这个事件根本没进 SSE 白名单——用户只能干等 4 分钟超时后的汇总，全程没有回声。
  const [squad, setSquad] = useState<Record<string, { total: number; done: number; failed: number; running: Record<string, string> }>>({});
  // provider 健康提示去重（60s 窗口：同一 provider 连续失败不刷屏）
  const providerToastAtRef = useRef(new Map<string, number>());

  const abortRef = useRef<AbortController | null>(null);
  const [currentRun, setCurrentRun] = useState<RunInfo | null>(null);
  const currentRunRef = useRef<RunInfo | null>(null);
  currentRunRef.current = currentRun;
  // 消息镜像 ref：retry 时刻同步读取（state 提交前也能拿到当前值）
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  // 会话镜像 ref：全局事件回调里判断"这条是不是当前会话的"（避免闭包捕获旧 activeId）
  const activeIdRef = useRef<string | null>(activeId);
  activeIdRef.current = activeId;
  // 本会话经历过的 traceId：轨迹面板据此只显示"这场对话"的步骤（旧版把别的会话的
  // trace.step 也混进来，你在 A 会话里看到 B 会话正在干什么）
  const traceIdsRef = useRef(new Set<string>());
  // 审批状态机（挂起集合的三个来源 + 超时撤卡 + 回答）：见 hooks/useApprovals.ts
  const pushSystemMessage = useCallback((id: string, text: string) => {
    setMessages((m) => [...m, { id, role: 'system', content: text, ts: Date.now() }]);
  }, [clearTraceSteps]);
  const { approvals, onApprovalRequired: onApprovalFromStream, onGlobalApproval: onApprovalFromBus, respond: respondApproval } =
    useApprovals({ activeId, pushSystemMessage });

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
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.documentElement.setAttribute('data-sonner-theme', theme);
    // 浏览器窗口 chrome（标题栏/状态栏）跟随明暗主题
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#161411' : '#fff8ed');
    applyFavicon();
    try { localStorage.setItem('maharness-theme', theme); } catch { /* 忽略 */ }
  }, [theme]);

  // 品牌色板预设（与明暗正交）：写 dataset + localStorage，并让 favicon 取新主色
  useEffect(() => {
    document.documentElement.dataset.brand = brand;
    try { localStorage.setItem('maharness-brand', brand); } catch { /* 忽略 */ }
    applyFavicon();
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

  useEffect(() => {
    const off = subscribeEvents((e: BusEvent) => {
      if (e.type === 'trace.step') {
        // 只收本会话的：/api/events 是全局广播，不过滤就会在 A 会话面板里看到 B 会话的步骤
        const step = e.data as TraceStep;
        if (!traceIdsRef.current.has(step.traceId)) return;
        recordTraceStep(step);
      }
      else if (e.type === 'plan.updated') {
        // 计划同样按会话归属过滤：全局广播里别的会话的目标不该顶到你的窗口上
        const d = e.data as (PlanState & { sessionId?: string }) | null;
        if (d?.sessionId && activeIdRef.current && d.sessionId !== activeIdRef.current) return;
        setPlan(d);
      }
      else if (e.type === 'todo.updated') setTodos((e.data as { cards: TodoCard[] } | null)?.cards ?? []);
      else if (e.type === 'parallel.progress') {
        // 并行小队分头干活的进度：phase=start/done/fail + taskId/objective/total/sessionId
        const d = e.data as { phase: 'start' | 'done' | 'fail'; taskId: string; objective: string; sessionId?: string; total?: number };
        if (!d?.taskId) return;
        const sid = d.sessionId ?? activeIdRef.current ?? '';
        setSquad((prev) => {
          const cur = prev[sid] ?? { total: 0, done: 0, failed: 0, running: {} };
          const running = { ...cur.running };
          if (d.phase === 'start') running[d.taskId] = d.objective;
          else delete running[d.taskId];
          return {
            ...prev,
            [sid]: {
              total: d.total ?? cur.total,
              done: cur.done + (d.phase === 'done' ? 1 : 0),
              failed: cur.failed + (d.phase === 'fail' ? 1 : 0),
              running,
            },
          };
        });
      }
      else if (e.type === 'approval.requested') {
        // 子代理/并行任务的审批经全局事件广播（主执行器阻塞在子任务 handler 内，
        // 审批事件无法从其 SSE 流到达）。合并逻辑（去重 + 补凭据）在 useApprovals 内。
        onApprovalFromBus(e.data as { approvalId: string; name: string; summary: string; sessionId?: string; createdAt?: number; expiresAt?: number; approvalToken?: string });
      }
      else if (e.type === 'provider.error') {
        // Provider 健康回报（agent failover 链真实调用失败）：刷新健康标记 + 即时提示，
        // 不等整条链耗尽才发现。同类提示 60s 内去重（连续消息失败不刷屏）
        const d = e.data as { providerId: string; providerLabel: string; authFailed: boolean; error: string };
        if (!d?.providerId) return;
        const now = Date.now();
        const last = providerToastAtRef.current.get(d.providerId) ?? 0;
        if (now - last < 60_000) return;
        providerToastAtRef.current.set(d.providerId, now);
        void providersApi.list().then(setProviders).catch(() => undefined);
        if (d.authFailed) {
          toast.error(`这条线路的钥匙好像过期了（${d.providerLabel}），我已经换了一条接着陪你聊`);
          toast.warning('有空在「设置」里换一下新钥匙', { duration: 5000 });
        } else {
          toast.warning(`${d.providerLabel} 刚才没接上，我换了条线路再说一遍`);
        }
      }
      else if (e.type === 'provider.ok') {
        // Provider 恢复（key 换好后首次成功）：清除红标
        void providersApi.list().then(setProviders).catch(() => undefined);
      }
    }, setLiveState);
    return () => { off(); };
  }, []);

  // trace 统计轮询：只在轨迹面板可见时进行（关面板 = 零后台请求）
  useEffect(() => {
    if (!traceOpen || activeTab !== 'chat') return;
    void traceApi.stats().then(setTraceStats).catch(() => undefined);
    const t = setInterval(() => { void traceApi.stats().then(setTraceStats).catch(() => undefined); }, 2000);
    return () => clearInterval(t);
  }, [traceOpen, activeTab]);

  // ---- 审批：状态机已抽到 hooks/useApprovals.ts（三个挂起来源 + 超时撤卡 + 回答）----

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
      const [ss, ms, pl, pvs, diagnostics] = await Promise.all([sessionApi.list(), modelsApi.list(), pluginsApi.list(), providersApi.list(), pluginsApi.diagnostics()]);
      setSessions(ss);
      setModels(ms);
      setPlugins(pl);
      setPluginDiagnostics(diagnostics);
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
        initialId = ss.find(session => session.id === new URLSearchParams(location.search).get('session'))?.id ?? ss[0].id;
      }
      setActiveId(initialId);
    } catch (err) {
      console.error('[maharness] 初始加载失败:', err);
      toast.error(`初始加载失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const selectSession = useCallback(async (id: string) => {
    setActiveTab('chat');
    setSettingsOpen(false);
    if (id === activeIdRef.current) return;
    abortRef.current?.abort();
    setStreaming(false); setCurrentRun(null);
    setActiveId(id);
    setMessages([]);
    clearTraceSteps();
    traceIdsRef.current = new Set();   // 换会话 = 换 trace 域：旧会话的步骤不再串进面板
    setStreamStatus(null);
    setPlan(null);
    setCheckpoint(null);
    setBudgetHit(null);
    setSessionCost(0);

  }, []);

  const createSession = useCallback(async () => {
    try {
      const s = await sessionApi.create(sel?.model ?? '');
      setSessions((prev) => [s, ...prev]);
      setActiveId(s.id);
      setMessages([]);
      clearTraceSteps();
      traceIdsRef.current.clear();
      setPlan(null);
      setCheckpoint(null);
      setBudgetHit(null);
      setSessionCost(0);
      toast.success('已创建新会话');
    } catch (err) {
      toast.error(`新建会话失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [sel, clearTraceSteps]);

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
        else { setActiveId(null); setMessages([]); clearTraceSteps(); traceIdsRef.current.clear(); setPlan(null); }
      }
      return next;
    });
  }, [activeId, selectSession, clearTraceSteps]);

  const archiveSession = useCallback(async (id: string, archived: boolean) => {
    try {
      await sessionApi.update(id, { archived });
      setSessions(await sessionApi.list());
      toast.success(archived ? '会话已归档' : '会话已取消归档');
    } catch (err) {
      toast.error(`归档操作失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  const pinSession = useCallback(async (id: string, pinned: boolean) => {
    try {
      await sessionApi.update(id, { pinned });
      setSessions(await sessionApi.list());
      toast.success(pinned ? '会话已置顶' : '会话已取消置顶');
    } catch (err) {
      toast.error(`置顶操作失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  /** 批量删除（后端事务原子批量接口） */
  const batchDelete = useCallback(async (ids: string[]) => {
    if (!ids.length) return;
    try {
      const r = await sessionApi.batchRemove(ids);
      setSessions(await sessionApi.list());
      if (activeId && ids.includes(activeId)) {
        const next = sessions.filter((s) => !ids.includes(s.id));
        if (next.length) void selectSession(next[0].id);
        else { setActiveId(null); setMessages([]); clearTraceSteps(); traceIdsRef.current.clear(); setPlan(null); }
      }
      toast.success(`已删除 ${r.removed ?? ids.length} 个会话`);
    } catch (err) {
      toast.error(`批量删除失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [activeId, sessions, selectSession, clearTraceSteps]);

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
  }, []);

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
  }, []);

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
  }, [activeId]);

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
  }, [models, activeId]);

  const pluginAction = useCallback(async (id: string, action: 'enable' | 'disable' | 'reload' | 'uninstall') => {
    try {
      const r = await pluginsApi.action(id, action);
      const [latest, diagnostics] = await Promise.all([pluginsApi.list(), pluginsApi.diagnostics()]);
      setPlugins(latest);
      setPluginDiagnostics(diagnostics);
      const label = action === 'enable' ? '已启用' : action === 'disable' ? '已停用' : action === 'uninstall' ? '已卸载' : '已重载';
      toast.success(`${label}（${id} · ${r.state}）`);
    } catch (err) {
      const label = action === 'enable' ? '启用' : action === 'disable' ? '停用' : action === 'uninstall' ? '卸载' : '重载';
      toast.error(`插件${label}失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  const refreshProviders = useCallback(async () => {
    try {
      setProviders(await providersApi.list());
      setModels(await modelsApi.list());
    } catch (err) {
      toast.error(`刷新 Provider 失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  /** 流式回复处理器（send 与断点续跑共用；文本增量经 rAF 合帧批量提交）
   *  实时路径刻意产出与 replayMessages() 完全相同的形状：开始办事的那几轮文本挪进
   *  narration（旁白）、工具卡带 tool_call_id、「加入了群聊」交给渲染期派生——
   *  于是「刷新一次还是这场对话」，而不是换副面孔（旧的空气泡就是这么来的）。 */
  const makeStreamHandlers = useCallback((assistantId: string) => ({
    onRun: (run: RunInfo) => { if (run.sessionId === activeIdRef.current) setCurrentRun(run); },
    onStart: (traceId: string) => {
      traceIdsRef.current = traceId ? new Set([traceId]) : new Set();
      clearTraceSteps();
      // 新一轮开始：清掉上一轮的小队进度（否则"2/4"会挂在新对话上）
      const sid = activeIdRef.current ?? '';
      setSquad((prev) => ({ ...prev, [sid]: { total: 0, done: 0, failed: 0, running: {} } }));
    },
    onDelta: (t: string) => queueStreamText(assistantId, { content: t }),
    onReasoning: (t: string) => queueStreamText(assistantId, { reasoning: t }),
    onStatus: (text: string) => setStreamStatus(text),
    onToolStart: (id: string | undefined, name: string, args: unknown) => {
      flushStreamBuffer();
      setStreamStatus(null);
      setMessages((prev) => prev.map((m) => {
        if (m.id !== assistantId) return m;
        // 这一轮转去办事了：此前流出的文本是说给它自己听的旁白，从正文挪走
        // （旧行为是让它留在正文里、最后被 done 的全文整体替换——
        //  用户会看见对方先冒出一串英文工作日志、说完又被抽走）
        const said = m.content.slice(m.retryFrom ?? 0).trim();
        return {
          ...m,
          narration: said ? [...(m.narration ?? []), said] : m.narration,
          content: '',
          retryFrom: undefined,
          tools: [...(m.tools ?? []), { id, name, args, status: 'running' as const, startedAt: Date.now() }],
        };
      }));
    },
    onToolResult: (id: string | undefined, name: string, summary: string, ok: boolean, stored?: boolean, evidence?: ToolEvidence[], warnings?: ToolWarning[]) => {
      flushStreamBuffer();
      setMessages((prev) => prev.map((m) => m.id === assistantId ? {
        ...m, tools: (m.tools ?? []).map((t) => t.status === 'running' && (t.id ? t.id === id : t.name === name) ? {
          ...t, summary, ok, stored, evidence, warnings, status: ok ? 'done' as const : 'error' as const, durationMs: Date.now() - (t.startedAt ?? Date.now()),
        } : t),
      } : m));
    },
    onApprovalRequired: onApprovalFromStream,
    onHandoff: (role: string, objective: string) => {
      // 角色移交：消息流插入系统通知；会话角色由后端持久化（刷新列表同步）
      flushStreamBuffer();
      setMessages((prev) => [...prev, { id: `ho-${Date.now()}`, role: 'system', content: sys.handoff(role, objective), ts: Date.now() }]);
      void sessionApi.list().then(setSessions).catch(() => undefined);
    },
    onBudgetHit: (cost: number, budget: number) => {
      // 成本熔断：横幅展示（harness 硬边界）
      setBudgetHit({ cost, budget });
    },
    onTaskVerified: (objective: string, checks: TaskVerificationInfo['checks'], evidence?: TaskVerificationInfo['evidence']) => {
      setStreamStatus('任务验收通过（有执行证据）');
      setMessages((prev) => prev.map((m) => m.id === assistantId ? { ...m, taskVerification: { status: 'verified', objective, checks, evidence: evidence ?? [] } } : m));
    },
    onTaskPartial: (objective: string, checks: TaskVerificationInfo['checks'], evidence?: TaskVerificationInfo['evidence']) => {
      setStreamStatus('任务部分完成（请查看未满足的验收条件）');
      setMessages((prev) => prev.map((m) => m.id === assistantId ? { ...m, taskVerification: { status: 'partial', objective, checks, evidence: evidence ?? [] } } : m));
    },
    onTaskFailed: (objective: string, checks: TaskVerificationInfo['checks'], evidence?: TaskVerificationInfo['evidence']) => {
      setStreamStatus('任务验收未通过（已保留执行证据）');
      setMessages((prev) => prev.map((m) => m.id === assistantId ? { ...m, taskVerification: { status: 'failed', objective, checks, evidence: evidence ?? [] } } : m));
    },
    onTaskInference: (objective: string, inference: { confidence: number; basis: 'explicit' | 'inferred' | 'ambiguous'; needsConfirmation: boolean; rationale: string }) => {
      if (!inference.needsConfirmation) return;
      flushStreamBuffer();
      setMessages((prev) => [...prev, {
        id: `task-inference-${Date.now()}`,
        role: 'system',
        content: `目标“${objective}”缺少明确验收标准（置信度 ${Math.round(inference.confidence * 100)}%）：${inference.rationale}。可继续执行，补充验收条件后可自动校验结果。`,
        ts: Date.now(),
      }]);
    },
    onRetry: (reason: 'attempt' | 'failover' | 'narration', detail?: string) => {
      // provider 重试/换线路：截断边界记在消息上（含未冲刷增量），从该边界重新累积。
      // 同时把"刚才那次作废了"说出来——否则用户看到的是说过的话被一口气擦掉。
      const p = pendingStreamRef.current;
      const base = messagesRef.current.find((m) => m.id === assistantId);
      const pending = p?.id === assistantId ? p : null;
      const cutContent = (base?.content.length ?? 0) + (pending?.content.length ?? 0);
      const cutReasoning = (base?.reasoning?.length ?? 0) + (pending?.reasoning.length ?? 0);
      setMessages((prev) => prev.map((m) => m.id === assistantId ? { ...m, retryFrom: cutContent, retryFromReasoning: cutReasoning } : m));
      setStreamStatus(detail || (reason === 'failover' ? '这条线路没接通，换一个再说一遍…' : '刚才那下没接上，我再说一遍…'));
    },
    onDone: (d: { content: string; reasoning?: string; usage: { input: number; output: number }; cost: number; cached?: boolean }) => {
      flushStreamBuffer();
      setStreamStatus(null);
      setMessages((prev) => prev.map((m) => m.id === assistantId ? { ...m, content: d.content, reasoning: d.reasoning ?? m.reasoning, streaming: false, usage: d.usage, cost: d.cost, cached: d.cached } : m));
      setSessionCost((prev) => prev + (d.cost ?? 0));
    },
    onError: (e: string, kind?: ErrorKind) => {
      flushStreamBuffer(); // 失败前已生成的部分内容保留可见
      setStreamStatus(null);
      const gentle = kind === 'aborted' || kind === 'busy';
      const he = humanizeError(e, kind);
      setMessages((prev) => prev.map((m) => m.id === assistantId ? {
        ...m,
        streaming: false,
        // 用户自己按的停止：留一条温和的话，而不是把取消说成故障
        stopped: kind === 'aborted' ? true : m.stopped,
        error: gentle ? (kind === 'busy' ? he.text : undefined) : (he.text || e),
        errorRaw: gentle ? undefined : e,
        // 停止时正在说的那半句已经流出去了——归位到旁白，别让它凭空消失
        ...(kind === 'aborted' ? { narration: (m.content.trim() ? [...(m.narration ?? []), m.content.trim()] : m.narration), content: '' } : {}),
      } : m));
      if (!gentle && he.severe) toast.error(he.text);
      if (!gentle && he.hint) toast.warning(he.hint);
      // 错误结束（如超轮数/熔断/连接中断）→ 同步断点：未完成任务保留「继续任务」入口；
      // 同时复位全局 streaming——错误路径可能没有后续 'end' 事件（传输层断开），
      // 不复位则输入区与停止按钮锁死在 streaming 状态
      setStreaming(false);
      if (activeId) void Promise.resolve(null).then(setCheckpoint).catch(() => undefined);
    },
    onEnd: () => {
      flushStreamBuffer();
      setStreamStatus(null);
      setStreaming(false);
      // 任务正常完成 → 后端已清除断点
      setCheckpoint(null);
      setSessions((prev) => prev.map((s) => s.id === activeId ? { ...s, updatedAt: Date.now() } : s));
    },
  }), [activeId, queueStreamText, flushStreamBuffer, clearTraceSteps]);

  const send = useCallback(async (text: string, frameworkChangeId?: string, materials?: MaterialRef[]) => {
    if (!activeId || !text.trim() || streaming) return;
    setPendingInference(null);

    if (text.trim().startsWith('/')) {
      const systemMsg = (content: string) => setMessages((prev) => [...prev, { id: `cmd-${Date.now()}`, role: 'system', content, ts: Date.now() }]);
      try {
        const r = await commandsApi.exec(text.trim(), activeId);
        if (r.type === 'message') {
          systemMsg(r.data?.text ?? '');
        } else if (r.type === 'action') {
          const a = r.data?.action;
          if (a === 'new_session') await createSession();
          else if (a === 'clear') { setMessages([]); systemMsg(sys.cleared); }
          else if (a === 'set_mode') {
            const mode = r.data?.mode ?? 'normal';
            setSessions((prev) => prev.map((s) => s.id === activeId ? { ...s, mode } : s));
            systemMsg(sys.modeSet(mode === 'plan' ? '计划模式' : mode === 'goal' ? '目标模式' : '普通聊天'));
          } else if (a === 'set_model') {
            setSel({ provider: r.data?.provider ?? '', model: r.data?.model ?? '' });
            systemMsg(sys.modelSet(r.data?.model ?? ''));
          }
        } else if (!r.ok) {
          systemMsg(sys.commandFailed(r.error ?? '说不清为什么'));
        }
      } catch (err) {
        systemMsg(sys.commandFailed(err instanceof Error ? err.message : String(err)));
      }
      return;
    }

    const userMsg: ChatMessage = { id: `u-${Date.now()}`, role: 'user', content: text, ts: Date.now() };
    const assistantMsg: ChatMessage = { id: `a-${Date.now()}`, role: 'assistant', content: '', streaming: true, tools: [], narration: [], ts: Date.now() };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setStreaming(true);
    const ac = new AbortController();
    abortRef.current = ac;

    // provider 一并上送：两个 provider 有同名模型时，服务端按 provider 优先解析才不会答错人
    await streamChat(activeId, { message: text, model: sel?.model ?? '', provider: sel?.provider ?? '', frameworkChangeId, materials }, makeStreamHandlers(assistantMsg.id), ac.signal);

    try { setSessions(await sessionApi.list()); } catch { /* 会话列表刷新失败不影响本次回复 */ }
  }, [activeId, sel, streaming, createSession, makeStreamHandlers]);

  const confirmInference = useCallback((objective: string, acceptance: string) => {
    const condition = acceptance.trim();
    if (!condition) return;
    void send(`${objective}\n验收条件：${condition}`);
  }, [send]);

  const resumeTask = useCallback(async () => {
    if (!currentRun || streaming || currentRun.status !== 'interrupted') return;
    setResuming(true); setStreaming(true);
    const assistantMsg: ChatMessage = { id: `a-${Date.now()}`, role: 'assistant', content: '', streaming: true, tools: [], narration: [], ts: Date.now() };
    setMessages(previous => [...previous, assistantMsg]);
    const ac = new AbortController(); abortRef.current = ac;
    try { const run = await runsApi.resume(currentRun.id); setCurrentRun(run); await subscribeRun(run.id, makeStreamHandlers(assistantMsg.id), ac.signal, run.eventCursor ?? 0); }
    catch (error) { toast.error(String(error)); setStreaming(false); }
    finally { setResuming(false); }
  }, [currentRun, streaming, makeStreamHandlers]);

  const stop = useCallback(() => {
    const run = currentRunRef.current;
    if (run && activeRun(run)) void runsApi.cancel(run.id).then(setCurrentRun).catch(error => toast.error(String(error)));
  }, []);

  const newTask = useCallback(async (message: string) => {
    const run = currentRunRef.current;
    if (!run) return;
    await runsApi.cancel(run.id);
    let next = await runsApi.get(run.id);
    for (let attempt = 0; activeRun(next) && attempt < 60; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 500)); next = await runsApi.get(run.id);
    }
    if (activeRun(next)) throw new Error('任务仍在停止，请等待后重试');
    abortRef.current?.abort(); setStreaming(true);
    const assistantMsg: ChatMessage = { id: `a-${Date.now()}`, role: 'assistant', content: '', streaming: true, tools: [], narration: [], ts: Date.now() };
    setMessages(previous => [...previous.map(m => ({ ...m, streaming: false })), { id: `u-${Date.now()}`, role: 'user', content: message, ts: Date.now() }, assistantMsg]);
    const ac = new AbortController(); abortRef.current = ac;
    await streamChat(run.sessionId, { message, model: sel?.model, provider: sel?.provider }, makeStreamHandlers(assistantMsg.id), ac.signal);
  }, [sel, makeStreamHandlers]);

  const handlerRef = useRef(makeStreamHandlers);
  handlerRef.current = makeStreamHandlers;
  useEffect(() => {
    if (!activeId) return;
    setCurrentRun(null); setStreaming(false);
    const ac = new AbortController();
    setStreaming(true);
    void Promise.all([runsApi.list(activeId), sessionApi.messages(activeId), planApi.get(activeId).catch(() => null)]).then(async ([rows, msgs, pl]) => {
      if (ac.signal.aborted || activeIdRef.current !== activeId) return;
      setMessages(replayMessages(msgs));
      setPlan(pl?.plan ?? null);
      setSessionCost(msgs.reduce((total, message) => total + (message.cost ?? 0), 0));
      const run = rows.find(run => !run.parentId);
      setCurrentRun(run ?? null);
      if (run && activeRun(run)) {
        abortRef.current?.abort(); abortRef.current = ac;
        const assistantId = `run-${run.id}`;
        setMessages(previous => [...previous, { id: assistantId, role: 'assistant', content: '', streaming: true, tools: [], narration: [], ts: run.createdAt }]);
        await subscribeRun(run.id, handlerRef.current(assistantId), ac.signal);
      } else setStreaming(false);
    }).catch(error => { if (!ac.signal.aborted) { setStreaming(false); toast.error(String(error)); } });
    return () => { ac.abort(); abortRef.current?.abort(); };
  }, [activeId]);

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
  }, [activeId]);

  const refreshTraceStats = useCallback(() => {
    void traceApi.stats().then(setTraceStats).catch(() => undefined);
  }, []);

  const toggleSettings = useCallback(() => setSettingsOpen((v) => !v), []);

  const currentSession = sessions.find((s) => s.id === activeId);
  // 微信群聊隐喻：会话头显示成员数（maharness + 你 + 已入群的子代理）
  const groupMembers = useMemo(() => collectMembers(messages), [messages]);
  // 活的状态：会话头实时显示 agent 正在忙什么（像朋友的微信签名）
  const runningTool = useMemo(() => {
    for (const m of messages) {
      for (const t of m.tools ?? []) if (t.status === 'running') return t;
    }
    return null;
  }, [messages]);
  const activity = runningTool ? toolActivityLabel(runningTool.name) : null;

  // 切到后台：新消息提醒（标题角标 + 轻响，回前台恢复）
  const baseTitleRef = useRef(document.title);
  const notifiedRef = useRef(false);
  useEffect(() => {
    if (streaming && document.hidden && !notifiedRef.current) {
      document.title = `【新消息】${baseTitleRef.current}`;
      notifiedRef.current = true;
      dingOnce();
    }
  }, [streaming, messages.length]);
  useEffect(() => {
    const onVis = () => {
      if (!document.hidden) {
        document.title = baseTitleRef.current;
        notifiedRef.current = false;
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // 拍一拍（双击头像）：前端彩蛋，不耗 LLM—— warmth 来自被回应的感觉
  const pushSystem = useCallback((content: string) => {
    setMessages((prev) => [...prev, { id: `sys-${Date.now()}`, role: 'system', content, ts: Date.now() }]);
  }, []);

  // 气泡长按菜单「删除」：仅从当前视图移除（服务端记录保留，重进会话即还原）
  const removeMessage = useCallback((id: string) => {
    setMessages((prev) => prev.filter((m) => m.id !== id));
  }, []);
  const pluginRunning = plugins.filter((p) => p.state === 'started' || p.state === 'loaded').length;
  const modeLabel = currentSession?.mode === 'plan' ? '计划模式' : currentSession?.mode === 'goal' ? '目标模式' : '普通模式';
  const selModel = sel ? models.find((m) => m.id === `${sel.provider}@${sel.model}`) : undefined;
  const modelLabel = selModel ? `${selModel.label} · ${selModel.model}` : (sel?.model ? `${sel.provider} · ${sel.model}` : '');
  const modelTag = selModel?.model ?? sel?.model ?? '';
  // 当前 provider 密钥失效（健康回报）：会话横幅即时提示，不等 failover 链耗尽
  const activeProvider = sel?.provider ? providers.find((p) => p.id === sel.provider) : undefined;
  const providerAuthFailed = activeProvider?.health?.authFailed
    ? { label: activeProvider.label, lastError: activeProvider.health.lastError }
    : null;
  const modeItems = [
    { key: 'normal', label: '普通模式', sub: '自由对话', dot: 'var(--text-3)' },
    { key: 'plan', label: '计划模式', sub: '先出计划再执行', dot: 'var(--purple)' },
    { key: 'goal', label: '目标模式', sub: '以目标驱动多轮', dot: 'var(--orange)' },
  ];

  // ---- 插件贡献的标签页（声明式）：遍历 /api/nav 生成导航 ----
  // 插件在 plugin.json 声明 nav 即在前端拥有自己的一页；插件停用/热重载中，
  // 服务端不再列出它（navContributions 只列 started 插件）→ 标签自动消失，
  // 正停留在该页时回落到会话页。前端不认识任何插件，新增插件页面无需改前端。
  const [pluginNav, setPluginNav] = useState<PluginNavItem[]>([]);
  // 是否已成功取过一次导航：只有成功过，才能把「列表里没有」解读为「插件真的下线了」。
  // 否则瞬时失败（后端重启/热重载中）会把 activeTab 误判为失效而打回会话页。
  const navLoaded = useRef(false);
  const refreshNav = useCallback(() => {
    navApi.list()
      .then((r) => {
        navLoaded.current = true;
        setPluginNav([...r.items].sort((a, b) => b.order - a.order));
      })
      // 失败时保留上一次已知的导航：宁可让标签短暂陈旧，也不能因一次失败把用户
      // 从插件页踢回会话页（「插件页闪一下就没」的根因就是这里清空列表）
      .catch(() => undefined);
  }, []);
  useEffect(() => { refreshNav(); }, [refreshNav, plugins]);
  const pluginTabs = useMemo(
    () => pluginNav.map((n) => ({ key: n.key, label: n.label, icon: pluginIcon(n.icon) })),
    [pluginNav],
  );
  useEffect(() => {
    // 当前标签页的贡献者确实不在了（插件被停用/卸载）→ 回落到会话页，不留死页面。
    // 必须等成功取过一次导航才判定，避免把「还没加载/取失败」误当「插件没了」。
    if (!navLoaded.current) return;
    if (typeof activeTab === 'string' && activeTab.startsWith('plugin:')
      && !pluginNav.some((n) => n.key === activeTab)) {
      setActiveTab('chat');
    }
  }, [pluginNav, activeTab]);
  const activePluginNav = pluginNav.find((n) => n.key === activeTab) ?? null;

  const onTab = useCallback((t: MainTab) => {
    setActiveTab(t);
    setSettingsOpen(false);
  }, []);

  return (
    <AppView
      sessions={sessions}
      activeId={activeId}
      messages={messages}
      streaming={streaming}
      models={models}
      sel={sel}
      plugins={plugins}
      pluginDiagnostics={pluginDiagnostics}
      providers={providers}
      activeTab={activeTab}
      settingsOpen={settingsOpen}
      traceSteps={traceSteps}
      traceStats={traceStats}
      traceOpen={traceOpen}
      plan={plan}
      todos={todos}
      theme={theme}
      brand={brand}
      checkpoint={checkpoint}
      currentRun={currentRun}
      onNewTask={newTask}
      onFrameworkTask={(id, message) => { setActiveTab('chat'); void send(message, id); }}
      onRunChanged={() => { if (currentRun) void runsApi.get(currentRun.id).then(setCurrentRun); }}
      resuming={resuming}
      budgetHit={budgetHit}
      sessionCost={sessionCost}
      streamStatus={streamStatus}
      liveState={liveState}
      squad={squad}
      approvals={approvals}
      providerAuthFailed={providerAuthFailed}
      currentSession={currentSession}
      groupMembers={groupMembers}
      activity={activity}
      modeLabel={modeLabel}
      modelLabel={modelLabel}
      modelTag={modelTag}
      pluginRunning={pluginRunning}
      modeItems={modeItems}
      pluginTabs={pluginTabs}
      activePluginNav={activePluginNav}
      pendingInference={pendingInference}
      onTab={onTab}
      onSelectSession={(id) => void selectSession(id)}
      onCreateSession={() => void createSession()}
      onDeleteSession={(id) => void deleteSession(id)}
      onArchiveSession={(id, archived) => void archiveSession(id, archived)}
      onPinSession={(id, pinned) => void pinSession(id, pinned)}
      onRenameSession={(id, title) => void renameSession(id, title)}
      onBatchDelete={(ids) => void batchDelete(ids)}
      onBatchArchive={(ids) => void batchArchive(ids)}
      onToggleSettings={toggleSettings}
      onSetSessionMode={(mode) => void setSessionMode(mode)}
      onSelectModel={(id) => void selectModel(id)}
      onSend={(text, materials) => { void send(text, undefined, materials); }}
      onStop={stop}
      onResume={() => void resumeTask()}
      onApproval={respondApproval}
      onConfirmInference={confirmInference}
      onRoleReset={() => void handleRoleReset()}
      onRefreshTrace={refreshTraceStats}
      onRefreshProviders={() => void refreshProviders()}
      onPluginAction={pluginAction}
      onSystemMessage={pushSystem}
      onRemoveMessage={removeMessage}
      onTraceOpenChange={setTraceOpen}
      onThemeChange={setTheme}
      onBrandChange={setBrand}
      onActiveTabChange={setActiveTab}
      onSettingsOpenChange={setSettingsOpen}
    />
  );
}
