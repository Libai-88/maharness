// ui/src/components/ChatView.tsx —— 对话区（流式渲染 + 工具调用卡片）
import { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../types';

interface Props {
  messages: ChatMessage[];
  streaming: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  hasModels: boolean;
}

export default function ChatView({ messages, streaming, onSend, onStop, hasModels }: Props) {
  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const submit = () => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput('');
    onSend(text);
  };

  return (
    <div className="chat-body">
      <div className="messages">
        {messages.length === 0 && (
          <div className="welcome">
            <h2>自研 Web Agent</h2>
            <p>薄内核 · 全插件化 · 全程可观测。我可以读写工作区文件、调用工具。</p>
            {!hasModels && <p className="warn">尚未配置 LLM Provider —— 在 <code>web-agent/.env</code> 填入 API Key 后重启。</p>}
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            <div className="msg-label">{m.role === 'user' ? '你' : 'Agent'}</div>
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
              {m.content ? <div className="msg-text">{m.content}{m.streaming && <span className="cursor">▍</span>}</div>
                : m.streaming ? <div className="msg-text thinking"><span className="cursor">思考中▍</span></div> : null}
              {m.error && <div className="msg-error">{m.error}</div>}
              {m.usage && (
                <div className="msg-meta">
                  ↑{m.usage.input} · ↓{m.usage.output} tokens · 成本 ${(m.cost ?? 0).toFixed(5)}
                </div>
              )}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="input-bar">
        <textarea
          value={input}
          placeholder={hasModels ? '输入消息，Enter 发送，Shift+Enter 换行' : '请先在 .env 配置 LLM Provider'}
          rows={2}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
          disabled={!hasModels || streaming}
        />
        {streaming ? (
          <button className="btn stop" onClick={onStop}>停止</button>
        ) : (
          <button className="btn send" onClick={submit} disabled={!input.trim() || !hasModels}>发送</button>
        )}
      </div>
    </div>
  );
}
