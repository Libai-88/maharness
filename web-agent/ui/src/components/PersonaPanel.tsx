// ui/src/components/PersonaPanel.tsx —— 人设管理（L1 用户人设，指引 LLM 的关键）
import { useState } from 'react';
import { personasApi } from '../api';
import type { PersonaInfo } from '../types';

interface Props {
  personas: PersonaInfo[];
  onChanged: () => void;
}

export default function PersonaPanel({ personas, onChanged }: Props) {
  const [editing, setEditing] = useState<PersonaInfo | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = async (ok: boolean, text: string) => {
    setMsg({ ok, text });
    setTimeout(() => setMsg(null), 4000);
    if (ok) { setCreating(false); setEditing(null); onChanged(); }
  };

  const startCreate = () => {
    setCreating(true); setEditing(null); setName(''); setContent(''); setMsg(null);
  };
  const startEdit = (p: PersonaInfo) => {
    setEditing(p); setCreating(false); setName(p.name); setContent(p.content); setMsg(null);
  };

  const save = async () => {
    if (!name.trim() || !content.trim()) return refresh(false, '名称与内容均为必填');
    setMsg(null);
    try {
      if (creating) { await personasApi.create({ name: name.trim(), content: content.trim() }); await refresh(true, '已创建'); }
      else if (editing) { await personasApi.update(editing.id, { name: name.trim(), content: content.trim() }); await refresh(true, '已保存（热生效）'); }
    } catch (err) {
      await refresh(false, err instanceof Error ? err.message : String(err));
    }
  };

  const toggle = async (p: PersonaInfo) => {
    try {
      await personasApi.update(p.id, { enabled: !p.enabled });
      onChanged();
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    }
  };

  const remove = async (p: PersonaInfo) => {
    if (!confirm(`删除人设「${p.name}」？`)) return;
    try { await personasApi.remove(p.id); onChanged(); } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    }
  };

  const showForm = creating || editing;

  return (
    <div className="provider-panel">
      <div className="panel-section-title">人设（系统提示词）</div>
      <div className="provider-hint">L0 内核纪律固定 · L1 以下人设按序叠加（热生效）· L2 插件规则随插件自动增减</div>
      {msg && <div className={`provider-msg ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      {!showForm && (
        <>
          <button className="btn new-session" onClick={startCreate}>＋ 新建人设</button>
          {personas.map((p) => (
            <div key={p.id} className={`provider-card ${p.enabled ? '' : 'disabled'}`}>
              <div className="provider-head">
                <span className="provider-name">{p.name}</span>
                <button className={`toggle ${p.enabled ? 'on' : ''}`} onClick={() => void toggle(p)}>
                  {p.enabled ? '启用中' : '已停用'}
                </button>
              </div>
              <div className="provider-meta persona-preview">{p.content.slice(0, 120)}{p.content.length > 120 ? '…' : ''}</div>
              <div className="provider-actions">
                <button onClick={() => startEdit(p)}>编辑</button>
                <button onClick={() => void remove(p)} className="danger">删除</button>
              </div>
            </div>
          ))}
          {personas.length === 0 && <div className="empty-hint">还没有人设——新建一个，定义 Agent 的身份与规则</div>}
        </>
      )}

      {showForm && (
        <div className="provider-form">
          <div className="provider-form-title">{creating ? '新建人设' : `编辑 · ${editing!.name}`}</div>
          <label>名称<input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：代码助手 / 写作助手" /></label>
          <label>提示词内容（身份 / 语气 / 能力边界 / 规则）
            <textarea
              className="persona-textarea"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={'身份：…\n语气：…\n能力边界：…\n规则：\n1. 不要编造数据\n2. …'}
              rows={10}
            />
          </label>
          <div className="provider-actions">
            <button className="primary" onClick={() => void save()}>保存（热生效）</button>
            <button onClick={() => { setCreating(false); setEditing(null); }}>取消</button>
          </div>
        </div>
      )}
    </div>
  );
}
