// ui/src/components/ChatView.tsx —— 对话区（流式渲染 + 工具卡片 + 思考过程折叠 + Markdown + 命令面板）
import { useEffect, useRef, useState } from 'react';
import { commandsApi } from '../api';
import type { ApprovalItem, ChatMessage, CommandInfo, PlanState } from '../types';
import Markdown from './Markdown';

interface Props {
  messages: ChatMessage[];
  streaming: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  hasModels: boolean;
  approvals: ApprovalItem[];
  onApproval: (id: string, approved: boolean) => void;
  plan: PlanState | null;
}

export default function ChatView({ messages, streaming, onSend, onStop, hasModels, approvals, onApproval, plan }: Props) {
  const [input, setInput] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [cmdIdx, setCmdIdx] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // 加载命令清单（命令面板用）
  useEffect(() => {
    commandsApi.list().then((r) => setCommands(r.commands)).catch(() => undefined);
  }, []);

  const submit = (textOverride?: string) => {
    const text = (textOverride ?? input).trim();
    if (!text || streaming) return;
    setInput('');
    setCmdOpen(false);
    onSend(text);
  };

  /** 当前匹配的命令（输入 /xxx 时按前缀过滤；仅输入 / 时显示全部） */
  const matched = input.startsWith('/')
    ? commands.filter((c) => {
        const q = input.slice(1).toLowerCase();
        return !q || c.name.startsWith(q) || q.startsWith(c.name);
      })
    : [];

  /** 执行或补全选中命令：无参数命令直接执行；有参数命令（如 /model）补全并让用户继续输入 */
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

  const toggleReasoning = (id: string) =>
    setExpanded((e) => ({ ...e, [id]: !e[id] }));

  return (
    <div className="chat-body">
      <div className="messages">
        {/* 目标计划卡片：实时展示多步任务的推进状态 */}
        {plan && (
          <div className="plan-card">
            <div className="plan-title">🎯 {plan.completed ? '目标已完成' : '目标计划'}：{plan.objective}</div>
            <div className="plan-steps">
              {plan.steps.map((s, i) => (
                <div key={i} className={`plan-step ${s.status}`}>
                  <span className="plan-step-icon">
                    {s.status === 'done' ? '✅' : s.status === 'in_progress' ? '▶️' : s.status === 'blocked' ? '⛔' : '⬜'}
                  </span>
                  <span className="plan-step-title">{i + 1}. {s.title}</span>
                  {s.note && <div className="plan-step-note">{s.note}</div>}
                </div>
              ))}
            </div>
          </div>
        )}
        {messages.length === 0 && (
          <div className="welcome">
            <h2>maharness</h2>
            <p>薄内核 · 全插件化 · 全程可观测。我可以读写工作区文件、联网搜索，甚至可以给自己写新插件。</p>
            {!hasModels && <p className="warn">尚未配置 LLM Provider —— 在左侧「设置」中添加。</p>}
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            <div className="msg-label">{m.role === 'user' ? '你' : m.role === 'system' ? '系统' : 'Agent'}</div>
            <div className="msg-content">
              {m.tools && m.tools.length > 0 && (
                <div className="tools">
                  {m.tools.map((t, i) => (
                    <div key={i} className={`tool-card ${t.status}`}>
                      <span className="tool-name">{t.name}</span>
                      <span className="tool-status">{t.status === 'running' ? '执行中…' : t.status === 'done' ? '完成' : '失败'}</span>
                      {t.summary && <pre className="tool-summary">{t.summary}</pre>}
                    </div>
                  ))}
                </div>
              )}
              {/* 思考过程：默认折叠，可展开，限高滚动（不失控） */}
              {m.reasoning && m.reasoning.length > 0 && (
                <div className="reasoning">
                  <button className="reasoning-toggle" onClick={() => toggleReasoning(m.id)}>
                    🧠 思考过程{expanded[m.id] ? ' ▾' : ' ▸'}
                  </button>
                  {expanded[m.id] && (
                    <div className="reasoning-body">
                      <div className="reasoning-text">{m.reasoning}{m.streaming && <span className="cursor">▍</span>}</div>
                    </div>
                  )}
                </div>
              )}
              {m.content ? (
                <div className="msg-text">
                  {m.role === 'assistant' ? <Markdown text={m.content} /> : <div className="plain">{m.content}</div>}
                  {m.streaming && <span className="cursor">▍</span>}
                </div>
              ) : m.streaming ? (
                <div className="msg-text thinking"><span className="cursor">思考中▍</span></div>
              ) : null}
              {m.error && <div className="msg-error">{m.error}</div>}
              {m.usage && (
                <div className="msg-meta">
                  ↑{m.usage.input} · ↓{m.usage.output} tokens · 成本 ${(m.cost ?? 0).toFixed(5)}
                  {m.cached && <em className="cache-badge">⚡ 缓存命中</em>}
                </div>
              )}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* 审批卡片：危险操作等待用户决策（执行器级安全机制） */}
      {approvals.length > 0 && (
        <div className="approval-area">
          {approvals.map((a) => (
            <div key={a.id} className="approval-card">
              <div className="approval-title">🔐 需要审批 · {a.name}</div>
              <pre className="approval-summary">{a.summary}</pre>
              <div className="approval-actions">
                <button className="approve" onClick={() => onApproval(a.id, true)}>批准执行</button>
                <button className="reject" onClick={() => onApproval(a.id, false)}>拒绝</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="input-wrap">
        {/* 命令面板：输入 / 弹出，方向键选择，Enter 执行，Tab 补全，Esc 关闭 */}
        {cmdOpen && matched.length > 0 && (
          <div className="cmd-panel">
            <div className="cmd-panel-title">斜杠命令（Enter 执行 · Tab 补全 · Esc 关闭）</div>
            {matched.map((c, i) => (
              <div
                key={c.name}
                className={`cmd-item ${i === cmdIdx ? 'active' : ''}`}
                onMouseEnter={() => setCmdIdx(i)}
                onClick={() => applyCommand(c)}
              >
                <span className="cmd-name">/{c.name}{c.usage ? ` ${c.usage}` : ''}</span>
                <span className="cmd-desc">{c.description}</span>
                <span className="cmd-src">{c.source === 'builtin' ? '内置' : '插件'}</span>
              </div>
            ))}
          </div>
        )}
        <div className="input-bar">
          <textarea
            ref={inputRef}
            value={input}
            placeholder={hasModels ? '输入消息，Enter 发送，Shift+Enter 换行；输入 / 调出命令面板' : '请先在「设置」配置 LLM Provider'}
            rows={2}
            onChange={(e) => {
              setInput(e.target.value);
              setCmdOpen(e.target.value.startsWith('/'));
              setCmdIdx(0);
            }}
            onKeyDown={onKeyDown}
            disabled={!hasModels || streaming}
          />
          {streaming ? (
            <button className="btn stop" onClick={onStop}>停止</button>
          ) : (
            <button className="btn send" onClick={submit} disabled={!input.trim() || !hasModels}>发送</button>
          )}
        </div>
      </div>
    </div>
  );
}
