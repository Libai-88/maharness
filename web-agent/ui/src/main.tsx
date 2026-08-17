import React from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';
import App from './App';
import './styles.css';

// 首帧主题预置（与 index.html 内联脚本一致，双保险防闪烁）
try {
  document.documentElement.dataset.theme = localStorage.getItem('maharness-theme') === 'dark' ? 'dark' : 'light';
} catch { /* 忽略 */ }

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
    <Toaster
      theme="dark"
      richColors
      position="bottom-right"
      gap={8}
      visibleToasts={4}
      toastOptions={{
        style: {
          background: 'var(--bg-elev)',
          border: '1px solid var(--border)',
          color: 'var(--text-1)',
          fontFamily: 'var(--font-sans)',
          fontSize: '12.5px',
          boxShadow: 'var(--shadow-pop)',
        },
        classNames: {
          success: 'sonner-toast-success',
          error: 'sonner-toast-error',
          info: 'sonner-toast-info',
        },
      }}
    />
  </React.StrictMode>,
);
