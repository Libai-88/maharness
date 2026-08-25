// ui/src/components/Menu.tsx —— 通用下拉菜单（顶栏模式 / 模型选择）
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { popIn } from '../motion';
import { IconCheck } from './Icon';

export interface MenuItem {
  key: string;
  label: string;
  sub?: string;
  dot?: string;   // 前置色点（模式标识）
}

interface Props {
  trigger: React.ReactNode;
  items: MenuItem[];
  selectedKey?: string;
  onSelect: (key: string) => void;
  title?: string;
  width?: number;
  triggerTitle?: string;
  disabled?: boolean;
}

export default function Menu({ trigger, items, selectedKey, onSelect, title, width = 230, triggerTitle, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="menu" ref={ref}>
      <button
        className="tb-btn"
        onClick={() => setOpen((v) => !v)}
        title={triggerTitle}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
      >
        {trigger}
      </button>
      <AnimatePresence>
      {open && (
        <motion.div
          className="menu-pop"
          style={{ width }}
          role="menu"
          variants={popIn}
          initial="initial"
          animate="enter"
          exit="exit"
        >
          {title && <div className="menu-title">{title}</div>}
          {items.length === 0 && <div className="menu-empty">暂无可用项</div>}
          {items.map((it) => (
            <button
              key={it.key}
              className={`menu-item ${it.key === selectedKey ? 'selected' : ''}`}
              role="menuitem"
              onClick={() => { setOpen(false); onSelect(it.key); }}
            >
              {it.dot && <span className="menu-dot" style={{ background: it.dot }} />}
              <span className="menu-label">{it.label}</span>
              {it.sub && <span className="menu-sub">{it.sub}</span>}
              {it.key === selectedKey && <IconCheck size={12} />}
            </button>
          ))}
        </motion.div>
      )}
      </AnimatePresence>
    </div>
  );
}
