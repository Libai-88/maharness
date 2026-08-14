// ui/src/components/PluginPanel.tsx —— 插件管理面板（现场启停）
import type { PluginInfo } from '../types';

interface Props {
  plugins: PluginInfo[];
  onAction: (id: string, action: 'enable' | 'disable' | 'reload') => void;
}

export default function PluginPanel({ plugins, onAction }: Props) {
  return (
    <div className="plugin-list">
      <div className="plugin-hint">插件目录：<code>web-agent/plugins/</code>，现场写入自动热加载</div>
      {plugins.map((p) => (
        <div key={p.id} className={`plugin-card ${p.state}`}>
          <div className="plugin-head">
            <span className="plugin-name">{p.name}</span>
            <span className={`plugin-state ${p.state}`}>{p.state}</span>
          </div>
          <div className="plugin-meta">{p.id}@{p.version} · 能力: {p.caps.join(', ') || '无'}</div>
          {p.error && <div className="plugin-error">{p.error}</div>}
          <div className="plugin-actions">
            {p.state === 'started' || p.state === 'loaded' ? (
              <button onClick={() => onAction(p.id, 'disable')}>停用</button>
            ) : (
              <button onClick={() => onAction(p.id, 'enable')}>启用</button>
            )}
            <button onClick={() => onAction(p.id, 'reload')}>重载</button>
          </div>
        </div>
      ))}
    </div>
  );
}
