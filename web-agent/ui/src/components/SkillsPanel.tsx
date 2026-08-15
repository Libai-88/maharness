// ui/src/components/SkillsPanel.tsx —— 技能管理（内置 + 已安装 + 市场安装）
import { useEffect, useState } from 'react';
import { skillsApi } from '../api';
import type { SkillInfo } from '../types';

interface Props {
  onChanged: () => void;
}

export default function SkillsPanel({ onChanged }: Props) {
  const [installed, setInstalled] = useState<SkillInfo[]>([]);
  const [market, setMarket] = useState<{ name: string; description: string }[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [viewing, setViewing] = useState<{ name: string; content: string } | null>(null);

  const load = async () => {
    try {
      const r = await skillsApi.list();
      setInstalled(r.installed);
      setMarket(r.market);
    } catch { /* 忽略 */ }
  };
  useEffect(() => { void load(); }, []);

  const flash = (ok: boolean, text: string) => {
    setMsg({ ok, text });
    setTimeout(() => setMsg(null), 4000);
  };

  const install = async (name: string) => {
    try {
      await skillsApi.install(name);
      flash(true, `已安装 ${name}（热生效）`);
      await load();
      onChanged();
    } catch (err) { flash(false, err instanceof Error ? err.message : String(err)); }
  };

  const uninstall = async (name: string) => {
    if (!confirm(`卸载技能「${name}」？`)) return;
    try {
      await skillsApi.uninstall(name);
      flash(true, `已卸载 ${name}`);
      await load();
      onChanged();
    } catch (err) { flash(false, err instanceof Error ? err.message : String(err)); }
  };

  const view = async (name: string, source: string) => {
    try {
      const r = await skillsApi.read(name, source);
      setViewing({ name, content: r.content ?? '(无法读取)' });
    } catch (err) { flash(false, err instanceof Error ? err.message : String(err)); }
  };

  return (
    <div className="provider-panel">
      <div className="panel-section-title">技能（Skills）</div>
      <div className="provider-hint">技能是指导 Agent 的指南包（SKILL.md），Agent 在需要时按需读取。内置技能指导 Agent 自我设计。</div>
      {msg && <div className={`provider-msg ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      {viewing && (
        <div className="provider-form">
          <div className="provider-form-title">{viewing.name}</div>
          <pre className="skill-view">{viewing.content}</pre>
          <div className="provider-actions">
            <button onClick={() => setViewing(null)}>关闭</button>
          </div>
        </div>
      )}

      {!viewing && (
        <>
          <div className="provider-hint">已安装（{installed.length}）</div>
          {installed.map((s) => (
            <div key={s.name} className="provider-card">
              <div className="provider-head">
                <span className="provider-name">{s.name} <em className="skill-src">{s.source === 'builtin' ? '内置' : '用户'}</em></span>
              </div>
              <div className="provider-meta">{s.description}</div>
              <div className="provider-actions">
                <button onClick={() => void view(s.name, s.source)}>查看</button>
                {s.source === 'user' && <button className="danger" onClick={() => void uninstall(s.name)}>卸载</button>}
              </div>
            </div>
          ))}
          {installed.length === 0 && <div className="empty-hint">暂无技能</div>}

          {market.length > 0 && (
            <>
              <div className="provider-hint">市场可安装（{market.length}）——放入 web-agent/market/ 目录的技能包</div>
              {market.map((s) => (
                <div key={s.name} className="provider-card">
                  <div className="provider-head">
                    <span className="provider-name">{s.name}</span>
                  </div>
                  <div className="provider-meta">{s.description}</div>
                  <div className="provider-actions">
                    <button onClick={() => void install(s.name)}>安装</button>
                  </div>
                </div>
              ))}
            </>
          )}
        </>
      )}
    </div>
  );
}
