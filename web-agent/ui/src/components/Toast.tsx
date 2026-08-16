// ui/src/components/Toast.tsx —— 全局操作反馈（成功/失败/信息）
// 设计依据：ui-ux-pro-max「Forms & Feedback」——每次用户操作都必须有结果反馈；
// 悬停暂停计时、点击立即关闭；aria-live 供读屏播报。
import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { IconCheck, IconClose, IconInfo, IconWarn } from './Icon';

export type ToastKind = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
}

interface ToastApi {
  success(text: string): void;
  error(text: string): void;
  info(text: string): void;
}

const ToastCtx = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error('useToast 必须在 <ToastProvider> 内使用');
  return ctx;
}

let seq = 1;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    timers.current.delete(id);
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback((kind: ToastKind, text: string) => {
    const id = seq++;
    setItems((prev) => [...prev.slice(-3), { id, kind, text }]); // 最多同时 4 条
    const timer = setTimeout(() => dismiss(id), 4200);
    timers.current.set(id, timer);
  }, [dismiss]);

  const api = useRef<ToastApi>({
    success: (text) => push('success', text),
    error: (text) => push('error', text),
    info: (text) => push('info', text),
  }).current;

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div className="toast-stack" aria-live="polite" aria-label="操作反馈">
        {items.map((t) => (
          <div
            key={t.id}
            className={`toast toast-${t.kind}`}
            role="status"
            onMouseEnter={() => { const timer = timers.current.get(t.id); if (timer) clearTimeout(timer); }}
            onMouseLeave={() => { timers.current.set(t.id, setTimeout(() => dismiss(t.id), 4200)); }}
          >
            <span className="toast-icon">
              {t.kind === 'success' ? <IconCheck size={13} /> : t.kind === 'error' ? <IconWarn size={13} /> : <IconInfo size={13} />}
            </span>
            <span className="toast-text">{t.text}</span>
            <button className="toast-close" onClick={() => dismiss(t.id)} title="关闭" aria-label="关闭提示"><IconClose size={11} /></button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
