// ui/src/App.tsx —— 主布局与状态管理
import { useCallback, useEffect, useRef, useState } from 'react';
import { approvalsApi, commandsApi, modelsApi, personasApi, pluginsApi, providersApi, sessionApi, streamChat, subscribeEvents, traceApi } from './api';
import type { ApprovalItem, BusEvent, ChatMessage, ModelInfo, PersonaInfo, PlanState, PluginInfo, ProviderInfo, Session, TraceStep } from './types';
import ChatView from './components/ChatView';
import SessionList from './components/SessionList';
import PluginPanel from './components/PluginPanel';
import ProviderPanel from './components/ProviderPanel';
import PersonaPanel from './components/PersonaPanel';
import SkillsPanel from './components/SkillsPanel';
import FileTree from './components/FileTree';
import StatsPanel from './components/StatsPanel';
import TracePanel from './components/TracePanel';

type SideTab = 'sessions' | 'plugins' | 'files' | 'stats' | 'settings';

export default function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [sel, setSel] = useState<{ provider: string; model: string } | null>(null);
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [personas, setPersonas] = useState<PersonaInfo[]>([]);
  const [sideTab, setSideTab] = useState<SideTab>('sessions');
  const [traceSteps, setTraceSteps] = useState<TraceStep[]>([]);
  const [traceStats, setTraceStats] = useState<{ trace: Record<string, number>; cache: Record<string, number>; l1Enabled: boolean } | null>(null);
  const [traceOpen, setTraceOpen] = useState(false);
  const [approvals, setApprovals] = useState<ApprovalItem[]>([]);
  const [plan, setPlan] = useState<PlanState | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  // 初始加载
  useEffect(() => {
    void loadAll();
  }, []);

  async function loadAll() {
    const [ss, ms, pl, pvs, pns] = await Promise.all([sessionApi.list(), modelsApi.list(), pluginsApi.list(), providersApi.list(), personasApi.list()]);
    setSessions(ss);
    setModels(ms);
    setPlugins(pl);
    setProviders(pvs);
    setPersonas(pns);
    if (ms.length) setSel((prev) => prev ?? { provider: ms[0].id, model: ms[0].model });
    if (!ss.length) {
      const created = await sessionApi.create(ms[0]?.model ?? '');
      setSessions([created]);
      setActiveId(created.id);
    } else {
      setActiveId(ss[0].id);
    }
  }

  // 切换会话：加载历史
  const selectSession = useCallback(async (id: string) => {
    setActiveId(id);
    setMessages([]);
    setTraceSteps([]);
    setPlan(null); // 计划卡片属于会话，切换时清空（防跨会话残留）
    try {
      const msgs = await sessionApi.messages(id);
      setMessages(msgs.map((m) => ({ id: m.id, role: m.role === 'user' ? 'user' : 'assistant', content: m.content ?? '', reasoning: m.reasoning })));
    } catch { /* 忽略 */ }
  }, []);

  const createSession = useCallback(async () => {
    const s = await sessionApi.create(sel?.model ?? '');
    setSessions((prev) => [s, ...prev]);
    setActiveId(s.id);
    setMessages([]);
    setTraceSteps([]);
    setPlan(null);
  }, [sel]);

  const deleteSession = useCallback(async (id: string) => {
    await sessionApi.remove(id);
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id);
      if (activeId === id) {
        if (next.length) { void selectSession(next[0].id); } else {
          setActiveId(null);
          setMessages([]);
        }
      }
      return next;
    });
  }, [activeId, selectSession]);

  // 会话管理：归档 / 置顶标记
  const archiveSession = useCallback(async (id: string, archived: boolean) => {
    await sessionApi.update(id, { archived });
    setSessions(await sessionApi.list());
  }, []);

  const pinSession = useCallback(async (id: string, pinned: boolean) => {
    await sessionApi.update(id, { pinned });
    setSessions(await sessionApi.list());
  }, []);

  // 插件管理
  const pluginAction = useCallback(async (id: string, action: 'enable' | 'disable' | 'reload') => {
    await pluginsApi.action(id, action);
    setPlugins(await pluginsApi.list());
  }, []);

  // 供应商变更后：刷新列表与模型下拉（热生效）
  const refreshProviders = useCallback(async () => {
    setProviders(await providersApi.list());
    setModels(await modelsApi.list());
  }, []);

  // 人设变更后：刷新列表（后端已热注入）
  const refreshPersonas = useCallback(async () => {
    setPersonas(await personasApi.list());
  }, []);

  // Trace 实时订阅
  useEffect(() => {
    const off = subscribeEvents((e: BusEvent) => {
      if (e.type === 'trace.step') {
        setTraceSteps((prev) => [...prev.slice(-199), e.data as TraceStep]);
      } else if (e.type === 'plan.updated') {
        setPlan(e.data as PlanState | null);
      }
    });
    const t = setInterval(() => { void traceApi.stats().then(setTraceStats).catch(() => undefined); }, 2000);
    return () => { off(); clearInterval(t); };
  }, []);

  // 发送消息（斜杠命令走命令分发，不走 LLM）
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
    setStreaming(true);
    const ac = new AbortController();
    abortRef.current = ac;

    await streamChat(activeId, { message: text, model: sel?.model ?? '', provider: sel?.provider }, {
      onStart: () => {},
      onDelta: (t) => setMessages((prev) => prev.map((m) => m.id === assistantMsg.id ? { ...m, content: m.content + t } : m)),
      onReasoning: (t) => setMessages((prev) => prev.map((m) => m.id === assistantMsg.id ? { ...m, reasoning: (m.reasoning ?? '') + t } : m)),
      onToolStart: (name, args) => setMessages((prev) => prev.map((m) => m.id === assistantMsg.id ? {
        ...m, tools: [...(m.tools ?? []), { name, args, status: 'running' as const }],
      } : m)),
      onToolResult: (name, summary, ok) => setMessages((prev) => prev.map((m) => m.id === assistantMsg.id ? {
        ...m, tools: (m.tools ?? []).map((t) => t.name === name && t.status === 'running' ? { ...t, summary, ok, status: ok ? 'done' as const : 'error' as const } : t),
      } : m)),
      onApprovalRequired: (id, name, summary) => setApprovals((prev) => [...prev, { id, name, summary }]),
      onDone: (d) => setMessages((prev) => prev.map((m) => m.id === assistantMsg.id ? { ...m, content: d.content, reasoning: d.reasoning ?? m.reasoning, streaming: false, usage: d.usage, cost: d.cost } : m)),
      onError: (e) => setMessages((prev) => prev.map((m) => m.id === assistantMsg.id ? { ...m, streaming: false, error: e } : m)),
      onEnd: () => {
        setStreaming(false);
        setSessions((prev) => prev.map((s) => s.id === activeId ? { ...s, updatedAt: Date.now() } : s));
      },
    }, ac.signal);

    // 刷新会话列表（标题可能已自动生成）
    setSessions(await sessionApi.list());
  }, [activeId, sel, streaming, createSession]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setMessages((prev) => prev.map((m) => m.streaming ? { ...m, streaming: false } : m));
    setStreaming(false);
  }, []);

  // 审批响应：批准/拒绝后移除卡片
  const respondApproval = useCallback(async (id: string, approved: boolean) => {
    try { await approvalsApi.respond(id, approved); } catch { /* 审批已过期 */ }
    setApprovals((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const currentSession = sessions.find((s) => s.id === activeId);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-tabs">
          <button className={sideTab === 'sessions' ? 'tab active' : 'tab'} onClick={() => setSideTab('sessions')}>会话</button>
          <button className={sideTab === 'plugins' ? 'tab active' : 'tab'} onClick={() => setSideTab('plugins')}>插件</button>
          <button className={sideTab === 'files' ? 'tab active' : 'tab'} onClick={() => setSideTab('files')}>文件</button>
          <button className={sideTab === 'stats' ? 'tab active' : 'tab'} onClick={() => setSideTab('stats')}>统计</button>
          <button className={sideTab === 'settings' ? 'tab active' : 'tab'} onClick={() => setSideTab('settings')}>设置</button>
        </div>
        {sideTab === 'sessions' ? (
          <SessionList
            sessions={sessions}
            activeId={activeId}
            onSelect={selectSession}
            onCreate={createSession}
            onDelete={deleteSession}
            onArchive={archiveSession}
            onPin={pinSession}
          />
        ) : sideTab === 'plugins' ? (
          <PluginPanel plugins={plugins} onAction={pluginAction} />
        ) : sideTab === 'files' ? (
          <FileTree />
        ) : sideTab === 'stats' ? (
          <StatsPanel />
        ) : (
          <>
            <ProviderPanel providers={providers} onChanged={refreshProviders} />
            <PersonaPanel personas={personas} onChanged={refreshPersonas} />
            <SkillsPanel onChanged={refreshPersonas} />
          </>
        )}
      </aside>

      <main className="chat-area">
        <header className="chat-header">
          <div className="chat-title">{currentSession?.title ?? '新会话'}</div>
          <select
            className="mode-picker"
            value={currentSession?.mode ?? 'normal'}
            onChange={async (e) => {
              const mode = e.target.value;
              if (!activeId) return;
              try {
                await sessionApi.update(activeId, { mode });
                setSessions((prev) => prev.map((s) => s.id === activeId ? { ...s, mode } : s));
              } catch { /* 忽略 */ }
            }}
            title="会话模式：普通 / 计划（先计划后执行）/ 目标（自动建计划）"
          >
            <option value="normal">普通</option>
            <option value="plan">计划</option>
            <option value="goal">目标</option>
          </select>
          <select
            className="model-picker"
            value={sel ? `${sel.provider}:${sel.model}` : ''}
            onChange={(e) => {
              const [pid, ...rest] = e.target.value.split(':');
              const m = models.find((x) => x.id === pid && x.model === rest.join(':'));
              if (m) setSel({ provider: m.id, model: m.model });
            }}
            title="切换模型"
          >
            {models.length === 0 && <option value="">未配置 LLM（见「设置」）</option>}
            {models.map((m) => <option key={`${m.id}:${m.model}`} value={`${m.id}:${m.model}`}>{m.label} · {m.model}</option>)}
          </select>
          <button className="trace-toggle" onClick={() => setTraceOpen((v) => !v)} title="运行轨迹面板">
            {traceOpen ? '隐藏轨迹' : '运行轨迹'}
          </button>
        </header>
        <ChatView
          messages={messages}
          streaming={streaming}
          onSend={send}
          onStop={stop}
          hasModels={models.length > 0}
          approvals={approvals}
          onApproval={respondApproval}
          plan={plan}
        />
      </main>

      {traceOpen && (
        <aside className="trace-panel">
          <TracePanel steps={traceSteps} stats={traceStats} />
        </aside>
      )}
    </div>
  );
}
