import React from 'react';
import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'motion/react';
import App from './App';
import './styles.css';

// 首帧主题预置（与 index.html 内联脚本一致，双保险防闪烁）
try {
  document.documentElement.dataset.theme = localStorage.getItem('maharness-theme') === 'dark' ? 'dark' : 'light';
} catch { /* 忽略 */ }

// Toaster 由 App 挂载（theme 跟随明暗主题切换，不再硬编码 dark）
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MotionConfig reducedMotion="user">
      <App />
    </MotionConfig>
  </React.StrictMode>,
);
