// ui/src/components/PersonaPanel.tsx —— 人设管理（L1 用户人设，指引 LLM 的关键）
// 三层系统提示词：L0 内核纪律固定 · L1 以下人设按序叠加（热生效）· L2 插件规则随插件自动增减。
// 历史：本组件曾在 eb2557e 的"顶栏菜单化"重构中从 App 上摘掉而未删除，导致人设管理
// 一度没有 UI 入口（后端 /api/personas 与 personasApi 一直可用）。现作为设置页
// 「人设与提示词」子页重新接线（缺陷清单 F1 的处置：不是删掉死代码，而是把丢失的能力接回来）。
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { personasApi } from '../api';
import type { PersonaInfo } from '../types';
import Confirm, { type ConfirmRequest } from './Confirm';

export default function PersonaPanel() {
  const [personas, setPersonas] = useState<PersonaInfo[]>([]);
  const [editing, setEditing] = useState<PersonaInfo | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [confirmReq, setConfirmReq] = useState<ConfirmRequest | null>(null);

  const load = useCallback(async () => {
    try { setPersonas(await personasApi.list()); }
    catch (err) { toast.error(`人设没读到：${err instanceof Error ? err.message : String(err)}`); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const startCreate = () => { setCreating(true); setEditing(null); setName(''); setContent(''); };
  const startEdit = (p: PersonaInfo) => { setEditing(p); setCreating(false); setName(p.name); setContent(p.content); };
  const closeForm = () => { setCreating(false); setEditing(null); };

  const save = async () => {
    if (!name.trim() || !content.trim()) { toast.error('名称与内容均为必填'); return; }
    try {
      if (creating) { await personasApi.create({ name: name.trim(), content: content.trim() }); toast.success('人设已创建，下一轮对话即生效'); }
      else if (editing) { await personasApi.update(editing.id, { name: name.trim(), content: content.trim() }); toast.success('人设已保存（热生效）'); }
      closeForm();
      await load();
    } catch (err) {
      toast.error(`没保存上：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const toggle = async (p: PersonaInfo) => {
    try { await personasApi.update(p.id, { enabled: !p.enabled }); await load(); }
    catch (err) { toast.error(`切换失败：${err instanceof Error ? err.message : String(err)}`); }
  };

  const remove = (p: PersonaInfo) => {
    setConfirmReq({
      text: `删除人设「${p.name}」？该人设的提示词会立即从系统提示词里撤下。`,
      okText: '删除',
      danger: true,
      onOk: async () => {
        try { await personasApi.remove(p.id); await load(); toast.success('已删除'); }
        catch (err) { toast.error(`删除失败：${err instanceof Error ? err.message : String(err)}`); }
      },
    });
  };

  const showForm = creating || editing;

  return (
    <div className="provider-panel">
      <span className="page-title">人设与提示词</span>
      <div className="page-sub">L0 内核纪律固定 · L1 以下人设按序叠加（热生效）· L2 插件规则随插件自动增减</div>

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
                <button onClick={() => remove(p)} className="danger">删除</button>
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
            <button onClick={closeForm}>取消</button>
          </div>
        </div>
      )}
      <Confirm req={confirmReq} onClose={() => setConfirmReq(null)} />
    </div>
  );
}
