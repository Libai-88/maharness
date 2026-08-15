// ui/src/components/ChatView.tsx —— 主对话（Screen 1）：消息流 + 思考块 + 工具卡片 + 代码块 + 输入区 + 斜杠命令面板
import { useEffect, useRef, useState } from 'react';
import { commandsApi } from '../api';
import type { ApprovalItem, ChatMessage, CommandInfo, PlanState, ToolStep } from '../types';
import Markdown from './Markdown';
import BrandLogo from './BrandLogo';
import { IconBrain, IconCheck, IconChevronDown, IconCopy, IconLock, IconPlan, IconPlugin, IconPlus, IconRefresh, IconSend, IconSettings, IconSheep, IconStop, IconWarn } from './Icon';

interface Props {
  messages: ChatMessage[];
  streaming: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  hasModels: boolean;
  approvals: ApprovalItem[];
  onApproval: (id: string, approved: boolean) => void;
  plan: PlanState | null;
  modelLabel?: string;
  modelTag?: string;
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

/** 工具调用卡片（Warp 命令块风格） */
function ToolCard({ t }: { t: ToolStep }) {
  const [open, setOpen] = useState(false);
  const running = t.status === 'running';
  const show = open || running;
  const statusCls = t.status === 'done' ? 'ok' : t.status === 'error' ? 'err' : 'run';
  const statusTxt = running ? '执行中…' : t.status === 'done' ? '完成' : '失败';
  return (
    <div className={`tool-card ${running ? 'running' : ''}`} onClick={() => { if (!running) setOpen((v) => !v); }} style={{ cursor: running ? 'default' : 'pointer' }}>
      <div className="tool-head">
        <div className="tool-head-left">
          <span className={`tool-icon ${statusCls}`}>
            {t.status === 'done' ? <IconCheck size={12} /> : t.status === 'error' ? <IconWarn size={12} /> : <IconRefresh size={12} />}
          </span>
          <span className="tool-name">{t.name}</span>
          <span className="tool-path">{t.args ? argsSummary(t.args) : ''}</span>
        </div>
        <div className="tool-head-right">
          <span className={`tool-status ${statusCls}`}><span className="sd" />{statusTxt}</span>
          <span className="tool-dur">{fmtMs(t.durationMs)}</span>
          <span style={{ fontSize: 10, color: 'var(--text-4)', transform: show ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}>▾</span>
        </div>
      </div>
      {show && t.summary && (
        <div className="tool-body">
          <span className="t-out">{t.summary}</span>
        </div>
      )}
    </div>
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

export default function ChatView({ messages, streaming, onSend, onStop, hasModels, approvals, onApproval, plan, modelLabel = '', modelTag = '' }: Props) {
  const [input, setInput] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [cmdIdx, setCmdIdx] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);
  useEffect(() => { commandsApi.list().then((r) => setCommands(r.commands)).catch(() => undefined); }, []);

  const submit = (textOverride?: string) => {
    const text = (textOverride ?? input).trim();
    if (!text || streaming) return;
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
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  };

  return (
    <div className="chat-area">
      <div className="messages">
        <div className="messages-inner">
          {plan && (
            <div className="plan-card">
              <div className="p-title"><IconPlan size={14} /> {plan.completed ? '目标已完成' : '目标计划'}：{plan.objective}</div>
              {plan.steps.map((s, i) => (
                <div key={i} className={`plan-step ${s.status}`}>
                  <span className="ps-num">{s.status === 'done' ? '✓' : s.status === 'in_progress' ? '▶' : s.status === 'blocked' ? '!' : i + 1}</span>
                  <span>{i + 1}. {s.title}</span>
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
            </div>
          )}

          {messages.map((m) => (
            <div key={m.id} className="msg-row">
              {m.role !== 'user' ? (
                <>
                  <div className="msg-avatar"><IconSheep size={16} /></div>
                  <div className="msg-col">
                    <div className="msg-meta">
                      <span className="msg-author">maharness</span>
                      <span className="msg-tag">{modelTag || 'AI'}</span>
                      <span className="msg-extra">· {m.streaming ? '生成中…' : m.cached ? '⚡ 缓存命中' : ''}</span>
                    </div>
                    {m.tools && m.tools.length > 0 && m.tools.map((t, i) => <ToolCard key={`${t.name}-${i}`} t={t} />)}
                    {m.reasoning && m.reasoning.length > 0 && (
                      <div className="think-card">
                        <div className="think-head">
                          <span className="think-dot"><IconBrain size={12} /></span>
                          <span className="think-label">思考</span>
                          <span className="think-dur">{m.streaming ? '推理中…' : expanded[m.id] ? '▾' : '▸'}</span>
                          <button
                            style={{ marginLeft: 'auto', color: 'var(--text-4)', fontSize: 11 }}
                            onClick={() => setExpanded((e) => ({ ...e, [m.id]: !e[m.id] }))}
                          >
                            {m.streaming ? '流式' : expanded[m.id] ? '收起' : '展开'}
                          </button>
                        </div>
                        {(m.streaming || expanded[m.id]) && (
                          <div className="think-body">{m.reasoning}{m.streaming && <span className="stream-cursor" />}</div>
                        )}
                      </div>
                    )}
                    {m.content ? (
                      m.streaming ? (
                        <div className="assistant-text">{m.content}<span className="stream-cursor" /></div>
                      ) : (
                        renderContent(m.content)
                      )
                    ) : m.streaming ? (
                      <div className="assistant-text" style={{ color: 'var(--text-3)' }}>思考中<span className="stream-cursor" /></div>
                    ) : null}
                    {m.error && <div className="assistant-text" style={{ color: 'var(--red)' }}>{m.error}</div>}
                    {m.usage && (
                      <div className="msg-extra">
                        ↑{m.usage.input} · ↓{m.usage.output} tokens · ¥{(m.cost ?? 0).toFixed(4)}
                        {m.cached && <span style={{ color: 'var(--teal)' }}> · ⚡ 秒回（缓存）</span>}
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="msg-col" style={{ alignItems: 'flex-end' }}>
                  <div className="msg-meta" style={{ justifyContent: 'flex-end' }}>
                    <span className="msg-author">你</span>
                    <span className="msg-extra">刚刚</span>
                  </div>
                  <div className="user-bubble">{m.content}</div>
                </div>
              )}
            </div>
          ))}
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
                <button className="btn-primary" onClick={() => onApproval(a.id, true)}>批准执行</button>
                <button className="btn-ghost" onClick={() => onApproval(a.id, false)}>拒绝</button>
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
              <div className="cmd-list">
                {matched.map((c, i) => (
                  <div
                    key={c.name}
                    className={`cmd-item ${i === cmdIdx ? 'selected' : ''}`}
                    onMouseEnter={() => setCmdIdx(i)}
                    onClick={() => applyCommand(c)}
                  >
                    <span className="ci-icon" style={{ background: c.source === 'builtin' ? 'var(--blue-soft)' : 'var(--purple-soft)', color: c.source === 'builtin' ? 'var(--accent)' : 'var(--purple)' }}>
                      {c.source === 'builtin' ? <IconSettings size={12} /> : <IconPlugin size={12} />}
                    </span>
                    <span className="ci-name">/{c.name}{c.usage ? ` ${c.usage}` : ''}</span>
                    <span className="ci-desc">{c.description}</span>
                    {i === cmdIdx && <span className="ci-badge">⏎ 执行</span>}
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
            disabled={!hasModels || streaming}
          />
          <div className="composer-toolbar">
            <div className="comp-left">
              <button className="comp-btn" title="附加内容" aria-label="附加内容"><IconPlus size={15} /></button>
              <button className="comp-btn" title="工具"><span className="dot" style={{ background: 'var(--text-3)' }} />Workspace Write<IconChevronDown size={10} /></button>
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
        <div className="composer-hint">按 <span className="mono">/</span> 调出命令面板 · <span className="mono">Enter</span> 发送 · <span className="mono">Shift + Enter</span> 换行</div>
      </div>
    </div>
  );
}
