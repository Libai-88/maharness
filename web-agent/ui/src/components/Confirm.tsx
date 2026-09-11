// ui/src/components/Confirm.tsx —— 应用内二次确认（替代 window.confirm）
// 为什么不用原生 confirm：手账风的微信式界面里弹一个系统对话框，是整套体验里
// 最刺眼的一处违和——原生弹窗不可样式化、不可动效、在 Electron/移动端还会丢焦点。
// 用 portal 挂到 body：不受 .tab-content / .composer 等祖先的层叠上下文与 overflow 裁切影响
// （本仓库已有过"fixed 被祖先 filter 劫持"的教训，见 styles.css 中 .topbar 的注释）。
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { popIn } from '../motion';

export interface ConfirmRequest {
  /** 问句（一行说清后果） */
  text: string;
  /** 确定按钮文案（动词，别用"确定"） */
  okText?: string;
  /** 危险操作：确定键用红色 */
  danger?: boolean;
  onOk: () => void;
}

export default function Confirm({ req, onClose }: { req: ConfirmRequest | null; onClose: () => void }) {
  useEffect(() => {
    if (!req) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
      if (e.key === 'Enter') { e.stopPropagation(); req.onOk(); onClose(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [req, onClose]);

  return createPortal(
    <AnimatePresence>
      {req && (
        <motion.div className="cf-overlay" onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <motion.div
            className="cf-box"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
            variants={popIn}
            initial="initial"
            animate="enter"
            exit="exit"
          >
            <div className="cf-text">{req.text}</div>
            <div className="cf-actions">
              <button className="cf-cancel" onClick={onClose}>再想想</button>
              <button
                className={`cf-ok ${req.danger ? 'danger' : ''}`}
                autoFocus
                onClick={() => { req.onOk(); onClose(); }}
              >
                {req.okText ?? '好'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
