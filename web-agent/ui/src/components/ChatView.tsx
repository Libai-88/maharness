// ui/src/components/ChatView.tsx —— 主对话（Screen 1）：消息流 + 思考块 + 工具卡片 + 代码块 + 输入区 + 斜杠命令面板
import { useEffect, useRef, useState } from 'react';
import { commandsApi, onChatRetry } from '../api';
import type { ApprovalItem, ChatMessage, CheckpointInfo, CommandInfo, PlanState, TodoCard, ToolStep } from '../types';
import Markdown from './Markdown';
import BrandLogo from './BrandLogo';
import { IconBlock, IconBolt, IconBrain, IconCheck, IconChevronDown, IconChevronRight, IconCircle, IconCoin, IconCopy, IconLock, IconPaperclip, IconPause, IconPlan, IconPlay, IconPlugin, IconRefresh, IconReturn, IconSend, IconSettings, IconSheep, IconStop, IconSwitch, IconWarn } from './Icon';

interface Props {
  messages: ChatMessage[];
  streaming: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  hasModels: boolean;
  approvals: ApprovalItem[];
  onApproval: (id: string, approved: boolean) => void;
  plan: PlanState | null;
  /** todo 插件：当前会话的 to do list（模型执行任务时维护，实时更新） */
  todos?: TodoCard[];
  modelLabel?: string;
  modelTag?: string;
  /** 断点续跑（checkpoint）：任务中断后「继续任务」入口 */
  checkpoint?: CheckpointInfo | null;
  onResume?: () => void;
  resuming?: boolean;
  /** 角色接管（handoff）：当前会话由哪个角色处理（空 = 主代理） */
  role?: string;
  onRoleReset?: () => void;
  /** 成本熔断横幅（budget_hit） */
  budgetHit?: { cost: number; budget: number } | null;
  /** 会话累计成本（composer 实时显示） */
  sessionCost?: number;
}

function fmtMs(ms?: number): string {
  if (ms === undefined) return '';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function argsSummary(args: unknown): string {
  try {
    const s = JSON.stringify(args);
    return s.length > 90 ? `${s.slice(0, 90)}…` : s;
  } catch { return String(args); }
}

/** 工具调用卡片（Warp 命令块风格；stored=大结果已入结果存储，recall_tool_result 可重读） */
function ToolCard({ t }: { t: ToolStep }) {
  const [open, setOpen] = useState(false);
  const running = t.status === 'running';
  const show = open || running;
  const statusCls = t.status === 'done' ? 'ok' : t.status === 'error' ? 'err' : 'run';
  const statusTxt = running ? '执行中…' : t.status === 'done' ? '完成' : '失败';
  return (
    <div
      className={`tool-card ${running ? 'running' : t.status === 'done' ? 'done' : 'err'} ${show ? 'expanded' : ''}`}
      onClick={() => { if (!running) setOpen((v) => !v); }}
      style={{ cursor: running ? 'default' : 'pointer' }}
      role="button"
      tabIndex={running ? -1 : 0}
      aria-expanded={show}
      aria-label={`工具 ${t.name}（${statusTxt}）——点击${show ? '收起' : '展开'}详情`}
      onKeyDown={(e) => { if (!running && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setOpen((v) => !v); } }}
    >
      <div className="tool-head">
        <div className="tool-head-left">
          <span className={`tool-icon ${statusCls}`}>
            {t.status === 'done' ? <IconCheck size={12} /> : t.status === 'error' ? <IconWarn size={12} /> : <IconRefresh size={12} />}
          </span>
          <span className="tool-name">{t.name}</span>
          <span className="tool-path">{t.args ? argsSummary(t.args) : ''}</span>
          {t.stored && <span className="tool-stored" title="大结果已存入结果存储——Agent 可用 recall_tool_result 零副作用重读全文"><IconPaperclip size={10} /> 已存</span>}
        </div>
        <div className="tool-head-right">
          <span className={`tool-status ${statusCls}`}><span className="sd" />{statusTxt}</span>
          <span className="tool-dur">{fmtMs(t.durationMs)}</span>
          <span style={{ color: 'var(--text-4)', display: 'inline-flex', transform: show ? 'none' : 'rotate(-90deg)', transition: 'transform .15s' }}><IconChevronDown size={11} /></span>
        </div>
      </div>
      {t.summary && (
        <div className="tool-body">
          <span className="t-out">{t.summary}</span>
          {t.stored && <span className="tool-stored-note">完整结果已存入结果存储（本会话内 recall_tool_result 可重读，零副作用）</span>}
        </div>
      )}
    </div>
  );
}

/** 复制按钮（带瞬时 ✓ 反馈，hover 浮现于消息操作区） */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="ma-btn"
      title={copied ? '已复制' : '复制回复'}
      aria-label={copied ? '已复制' : '复制回复'}
      onClick={() => {
        navigator.clipboard?.writeText(text).catch(() => undefined);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
    </button>
  );
}

/** 代码块：简化语言高亮（关键字/字符串/注释） */
function CodeBlock({ code, lang = '' }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  const hl = code
    .split('\n')
    .map((line) =>
      line
        .replace(/(\/\/.*$)/, (m) => `<span class="cm">${m}</span>`)
        .replace(/('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g, (m) => `<span class="st">${m}</span>`)
        .replace(/\b(import|from|export|default|const|let|var|function|return|async|await|new|class|this|interface|type)\b/g, (m) => `<span class="kw">${m}</span>`),
    )
    .join('\n');
  return (
    <div className="code-block">
      <div className="code-head">
        <span className="code-lang"><span className="cl-dot" />{lang || 'code'}</span>
        <div className="code-actions">
          <button className="code-copy" onClick={() => { navigator.clipboard?.writeText(code).catch(() => undefined); setCopied(true); setTimeout(() => setCopied(false), 1200); }} title="复制代码" aria-label="复制代码">{copied ? <IconCheck size={12} /> : <IconCopy size={13} />}</button>
        </div>
      </div>
      <pre className="code-body" dangerouslySetInnerHTML={{ __html: hl }} />
    </div>
  );
}

/** 渲染 assistant 消息内容：含代码块的轻量 markdown 分段 */
function renderContent(text: string) {
  const parts: React.ReactNode[] = [];
  const blocks = text.split(/```(\w*)\n([\s\S]*?)```/g);
  for (let i = 0; i < blocks.length; i++) {
    if (i % 3 === 0) {
      if (blocks[i].trim()) parts.push(<div key={i} className="assistant-text"><Markdown text={blocks[i]} /></div>);
    } else if (i % 3 === 1) {
      parts.push(<CodeBlock key={i} code={blocks[i + 1] ?? ''} lang={blocks[i]} />);
      i++;
    }
  }
  return parts;
}

export default function ChatView({ messages, streaming, onSend, onStop, hasModels, approvals, onApproval, plan, todos = [], modelLabel = '', modelTag = '', checkpoint, onResume, resuming = false, role, onRoleReset, budgetHit, sessionCost = 0 }: Props) {
  const [input, setInput] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [pendingApprovals, setPendingApprovals] = useState<Record<string, 'approve' | 'reject'>>({});
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [cmdIdx, setCmdIdx] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  // 输入历史（↑/↓ 回放，终端习惯——快速高效响应）
  const [inputHist, setInputHist] = useState<string[]>([]);
  const histIdxRef = useRef(-1);

  // C1 前端适配：provider 重试（retry 事件）→ 作废当前流式渲染、从 retry 边界重新累积。
  // 消息状态归父组件所有（onDelta 持续向 content 追加），本组件在渲染层记录 retry 时刻
  // 流式消息的内容/思考长度，展示时截掉该边界之前的残段——等价于"清空重累积"，
  // 防止显示「上次失败残段 + 重试全文」的重复内容。仅对流式中的消息生效：
  // done 后 content 被最终全文整体替换，无需（也不应）截断。
  const [retryMarks, setRetryMarks] = useState<Record<string, { content: number; reasoning: number }>>({});
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  useEffect(() => onChatRetry(() => {
    const m = messagesRef.current.find((x) => x.streaming && x.role === 'assistant');
    if (m) setRetryMarks((prev) => ({ ...prev, [m.id]: { content: m.content.length, reasoning: (m.reasoning ?? '').length } }));
  }), []);

  useEffect(() => {
    // 自动滚动（设置页可关）：新消息/流式内容自动滚到底部
    let auto = true;
    try { auto = localStorage.getItem('maharness-auto-scroll') !== 'off'; } catch { /* 忽略 */ }
    if (auto) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);
  useEffect(() => { commandsApi.list().then((r) => setCommands(r.commands)).catch(() => undefined); }, []);

  const submit = (textOverride?: string) => {
    const text = (textOverride ?? input).trim();
    if (!text || streaming) return;
    if (textOverride === undefined && text) {
      setInputHist((prev) => [text, ...prev].slice(0, 30));
      histIdxRef.current = -1;
    }
    setInput('');
    setCmdOpen(false);
    onSend(text);
  };

  const matched = input.startsWith('/')
    ? commands.filter((c) => {
        const q = input.slice(1).toLowerCase();
        return !q || c.name.startsWith(q) || q.startsWith(c.name);
      })
    : [];

  const applyCommand = (cmd: CommandInfo, execute = true) => {
    if (cmd.usage) {
      setInput(`/${cmd.name} `);
      inputRef.current?.focus();
      setCmdOpen(false);
    } else if (execute) {
      setInput(`/${cmd.name}`);
      submit(`/${cmd.name}`);
    } else {
      setInput(`/${cmd.name} `);
      inputRef.current?.focus();
      setCmdOpen(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (cmdOpen && matched.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setCmdIdx((i) => (i + 1) % matched.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setCmdIdx((i) => (i - 1 + matched.length) % matched.length); return; }
      if (e.key === 'Escape') { e.preventDefault(); setCmdOpen(false); return; }
      if (e.key === 'Tab') { e.preventDefault(); applyCommand(matched[cmdIdx], false); return; }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); applyCommand(matched[cmdIdx]); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); return; }
    // 输入历史回放（↑/↓）：空输入框时↑取上一条（终端习惯）
    if (e.key === 'ArrowUp' && !input && inputHist.length > 0) {
      e.preventDefault();
      histIdxRef.current = Math.min(histIdxRef.current + 1, inputHist.length - 1);
      setInput(inputHist[histIdxRef.current]);
    } else if (e.key === 'ArrowDown' && histIdxRef.current >= 0) {
      e.preventDefault();
      histIdxRef.current -= 1;
      setInput(histIdxRef.current >= 0 ? inputHist[histIdxRef.current] : '');
    }
    // Esc 停止（streaming 时；与停止按钮等价）
    if (e.key === 'Escape' && streaming) { e.preventDefault(); onStop(); }
  };

  return (
    <div className="chat-area">
      {/* ---- 会话状态横幅（agent harness 前端特征：可恢复 / 可干预 / 边界可见） ---- */}
      {(role || (checkpoint?.exists && !streaming) || budgetHit) && (
        <div className="session-banners">
          {checkpoint?.exists && !streaming && !resuming && (
            <div className="sess-banner resume">
              <span className="sb-icon"><IconPause size={13} /></span>
              <span className="sb-text">任务中断于第 {checkpoint.turn + 1} 轮（{checkpoint.historyMessages} 条上下文已存档）——可无缝继续，不丢已完成的工作</span>
              <button className="sb-btn" onClick={onResume} disabled={resuming}>继续任务</button>
            </div>
          )}
          {resuming && (
            <div className="sess-banner resume">
              <span className="sb-icon"><span className="spin" style={{ borderColor: 'var(--accent)' }} /></span>
              <span className="sb-text">正在从断点恢复…</span>
            </div>
          )}
          {role && (
            <div className="sess-banner role">
              <span className="sb-icon"><IconSwitch size={13} /></span>
              <span className="sb-text">会话由「<b>{role}</b>」角色接管（专业化分工）</span>
              <button className="sb-btn" onClick={onRoleReset}>交回主代理</button>
            </div>
          )}
          {budgetHit && (
            <div className="sess-banner budget">
              <span className="sb-icon"><IconCoin size={13} /></span>
              <span className="sb-text">成本预算已耗尽（${budgetHit.cost.toFixed(4)} / 预算 ${budgetHit.budget.toFixed(4)}）——harness 已熔断，不再发起新调用；已完成的结果保留在会话中</span>
            </div>
          )}
        </div>
      )}
      <div className="messages">
        <div className="messages-inner">
          {plan && (
            <div className="plan-card">
              <div className="p-title"><IconPlan size={14} /> {plan.completed ? '目标已完成' : '目标计划'}：{plan.objective}</div>
              {plan.steps.map((s, i) => (
                <div key={i} className={`plan-step ${s.status}`}>
                  <span className="ps-num">
                    {s.status === 'done' ? <IconCheck size={10} /> : s.status === 'in_progress' ? <IconPlay size={10} /> : s.status === 'blocked' ? <IconBlock size={10} /> : i + 1}
                  </span>
                  <span>{i + 1}. {s.title}</span>
                </div>
              ))}
            </div>
          )}

          {todos.length > 0 && (
            <div className="plan-card">
              <div className="p-title"><IconCheck size={14} /> To Do List · {todos.filter((t) => t.status === 'done').length}/{todos.length} 完成</div>
              {todos.map((t) => (
                <div key={t.id} className={`plan-step ${t.status}`}>
                  <span className="ps-num">
                    {t.status === 'done' ? <IconCheck size={10} /> : t.status === 'doing' ? <IconPlay size={10} /> : t.status === 'blocked' ? <IconBlock size={10} /> : <IconCircle size={10} />}
                  </span>
                  <span>{t.title}</span>
                  {t.desc && <span className="todo-note">{t.desc}</span>}
                </div>
              ))}
            </div>
          )}

          {messages.length === 0 && (
            <div className="brand-hero">
              <BrandLogo size={96} />
              <div className="brand-title">探索未至之境</div>
              <div className="brand-slogan">
                万物皆插件，自我进化——maharness 是你的羊，也是你的牧羊犬。<br />
                文件读写 · 命令执行 · 联网搜索 · 自我扩展
              </div>
              <div className="brand-kbd"><span className="bk">/</span> 调出命令面板 <span className="bk">Enter</span> 发送</div>
              {!hasModels && <div className="brand-note">尚未配置 LLM Provider —— 在左下角「设置」中添加。</div>}
              <div className="hero-pills">
                <button className="hero-pill" onClick={() => onSend('起草一份技术方案')}><span className="hp-ico">✦</span>起草一份技术方案</button>
                <button className="hero-pill" onClick={() => onSend('追踪插件重载信号')}><span className="hp-ico">◆</span>追踪插件重载信号</button>
                <button className="hero-pill" onClick={() => onSend('整理本周代码审查')}><span className="hp-ico">✚</span>整理本周代码审查</button>
              </div>
            </div>
          )}

          {messages.map((m) => {
            // retry 截断（C1）：流式中的 assistant 消息从最近一次 retry 边界起显示
            const mark = m.streaming && m.role === 'assistant' ? retryMarks[m.id] : undefined;
            const content = mark ? m.content.slice(mark.content) : m.content;
            const reasoning = mark ? (m.reasoning ?? '').slice(mark.reasoning) : m.reasoning;
            return (
            <div key={m.id} className={`msg-row ${m.streaming ? 'streaming' : ''} ${m.cached && !m.streaming ? 'cached' : ''}`}>
              {m.role !== 'user' ? (
                <>
                  <div className="msg-avatar"><IconSheep size={16} /></div>
                  <div className="msg-col">
                    <div className="msg-meta">
                      <span className="msg-author">maharness</span>
                      <span className="msg-tag">{modelTag || 'AI'}</span>
                      <span className="msg-extra">· {m.streaming ? '生成中…' : m.cached ? <><IconBolt size={11} /> 缓存命中</> : ''}</span>
                      {!m.streaming && m.content && (
                        <span className="msg-actions">
                          <CopyButton text={m.content} />
                        </span>
                      )}
                    </div>
                    {m.tools && m.tools.length > 0 && m.tools.map((t, i) => <ToolCard key={`${t.name}-${i}`} t={t} />)}
                    {reasoning && reasoning.length > 0 && (
                      <div className={`think-card ${(m.streaming || expanded[m.id]) ? 'expanded' : ''} ${m.streaming ? 'streaming' : ''}`}>
                        <div className="think-head">
                          <span className="think-dot"><IconBrain size={12} /></span>
                          <span className="think-label">{m.streaming ? '推理中' : '思考'}</span>
                          <span className="think-dur">{m.streaming ? '推理中…' : expanded[m.id] ? <IconChevronDown size={11} /> : <IconChevronRight size={11} />}</span>
                          <button
                            style={{ marginLeft: 'auto', color: 'var(--text-4)', fontSize: 11 }}
                            onClick={() => setExpanded((e) => ({ ...e, [m.id]: !e[m.id] }))}
                            aria-expanded={!!expanded[m.id]}
                          >
                            {m.streaming ? '流式' : expanded[m.id] ? '收起' : '展开'}
                          </button>
                        </div>
                        <div className="think-body">{reasoning}{m.streaming && <span className="stream-cursor" />}</div>
                      </div>
                    )}
                    {content ? (
                      m.streaming ? (
                        <div className="assistant-text">{content}<span className="stream-cursor" /></div>
                      ) : (
                        renderContent(content)
                      )
                    ) : m.streaming ? (
                      <div className="assistant-text" style={{ color: 'var(--text-3)' }}>思考中<span className="stream-cursor" /></div>
                    ) : null}
                    {m.error && <div className="assistant-text" style={{ color: 'var(--red)' }}>{m.error}</div>}
                    {m.usage && (
                      <div className="msg-extra">
                        ↑{m.usage.input} · ↓{m.usage.output} tokens · ¥{(m.cost ?? 0).toFixed(4)}
                        {m.cached && <span style={{ color: 'var(--teal)' }}> · <IconBolt size={11} /> 秒回（缓存）</span>}
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="msg-col" style={{ alignItems: 'flex-end' }}>
                  <div className="msg-meta" style={{ justifyContent: 'flex-end' }}>
                    <span className="msg-author">你</span>
                    <span className="msg-extra">刚刚</span>
                    {!streaming && (
                      <span className="msg-actions">
                        <button className="ma-btn" title="重新发送（重试）" aria-label="重新发送" onClick={() => submit(m.content)}><IconRefresh size={12} /></button>
                      </span>
                    )}
                  </div>
                  <div className="user-bubble">{m.content}</div>
                </div>
              )}
            </div>
            );
          })}
          <div ref={bottomRef} />
        </div>
      </div>

      {approvals.length > 0 && (
        <div style={{ padding: '0 24px 8px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {approvals.map((a) => (
            <div key={a.id} className="approval-card" style={{ maxWidth: 760, margin: '0 auto', width: '100%' }}>
              <div className="a-title"><span className="a-lock"><IconLock size={13} /></span> 需要审批 · {a.name}<span className="a-pulse" /></div>
              <pre className="a-summary">{a.summary}</pre>
              <div className="approval-actions">
                <button
                  className="btn-primary"
                  disabled={!!pendingApprovals[a.id]}
                  onClick={() => { setPendingApprovals((p) => ({ ...p, [a.id]: 'approve' })); onApproval(a.id, true); }}
                >
                  {pendingApprovals[a.id] === 'approve' ? <span className="spin" /> : null}批准执行
                </button>
                <button
                  className="btn-ghost"
                  disabled={!!pendingApprovals[a.id]}
                  onClick={() => { setPendingApprovals((p) => ({ ...p, [a.id]: 'reject' })); onApproval(a.id, false); }}
                >
                  {pendingApprovals[a.id] === 'reject' ? <span className="spin" /> : null}拒绝
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="composer-area">
        {cmdOpen && matched.length > 0 && (
          <div className="cmd-overlay" onClick={() => setCmdOpen(false)}>
            <div className="cmd-panel" onClick={(e) => e.stopPropagation()}>
              <div className="cmd-input-row">
                <span className="cmd-slash">/</span>
                <span className="cmd-typed">{input.slice(1)}</span>
                <span className="cmd-cursor" />
              </div>
              <div className="cmd-list" role="listbox" aria-label="斜杠命令">
                {matched.map((c, i) => (
                  <div
                    key={c.name}
                    className={`cmd-item ${i === cmdIdx ? 'selected' : ''}`}
                    role="option"
                    aria-selected={i === cmdIdx}
                    onMouseEnter={() => setCmdIdx(i)}
                    onClick={() => applyCommand(c)}
                  >
                    <span className="ci-icon" style={{ background: c.source === 'builtin' ? 'var(--blue-soft)' : 'var(--purple-soft)', color: c.source === 'builtin' ? 'var(--accent)' : 'var(--purple)' }}>
                      {c.source === 'builtin' ? <IconSettings size={12} /> : <IconPlugin size={12} />}
                    </span>
                    <span className="ci-name">/{c.name}{c.usage ? ` ${c.usage}` : ''}</span>
                    <span className="ci-desc">{c.description}</span>
                    {i === cmdIdx && <span className="ci-badge"><IconReturn size={9} /> 执行</span>}
                    <span className="ci-kbd">{c.source === 'builtin' ? '内置' : '插件'}</span>
                  </div>
                ))}
              </div>
              <div className="cmd-foot">
                <span className="cf-item"><span className="cf-kbd">↑↓</span><span className="cf-label">选择</span></span>
                <span className="cf-item"><span className="cf-kbd">Enter</span><span className="cf-label">执行</span></span>
                <span className="cf-item"><span className="cf-kbd">Tab</span><span className="cf-label">补全</span></span>
                <span className="cf-item"><span className="cf-kbd">Esc</span><span className="cf-label">关闭</span></span>
              </div>
            </div>
          </div>
        )}

        <div className="composer">
          <textarea
            ref={inputRef}
            value={input}
            placeholder={hasModels ? '描述你想构建的内容…（/ 调出命令面板）' : '请先在「设置」配置 LLM Provider'}
            rows={2}
            onChange={(e) => {
              setInput(e.target.value);
              setCmdOpen(e.target.value.startsWith('/'));
              setCmdIdx(0);
            }}
            onKeyDown={onKeyDown}
            // 流式期间不禁用：保留 Esc 停止 / ↑ 历史回放等键盘能力（发送由 submit 防护）
            disabled={!hasModels}
          />
          <div className="composer-toolbar">
            <div className="comp-left">
              <span className="comp-tools-label" title="工具将在对话中自动按需调用">工具自动调用</span>
              {sessionCost > 0 && (
                <span className="comp-cost" title="本会话累计成本（harness 管理认知资源）">本会话 ${sessionCost.toFixed(4)}</span>
              )}
            </div>
            <div className="comp-right">
              <span className="comp-model" title={modelLabel}>{modelLabel || '未选择模型'}<IconChevronDown size={10} /></span>
              {streaming ? (
                <button className="send-btn stop" onClick={onStop} title="停止" aria-label="停止"><IconStop size={14} /></button>
              ) : (
                <button className="send-btn" onClick={() => submit()} disabled={!input.trim() || !hasModels} title="发送" aria-label="发送"><IconSend size={15} /></button>
              )}
            </div>
          </div>
        </div>
        <div className="composer-hint">按 <span className="mono">/</span> 调出命令面板 · <span className="mono">Enter</span> 发送 · <span className="mono">Shift + Enter</span> 换行 · <span className="mono">↑</span> 回放上一条 · <span className="mono">Esc</span> 停止</div>
      </div>
    </div>
  );
}
