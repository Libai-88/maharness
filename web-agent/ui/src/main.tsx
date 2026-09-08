import React from 'react';
import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'motion/react';
import App from './App';
import './styles.css';
import './styles/brand.css';

// 首帧主题/品牌预置（与 index.html 内联脚本一致，双保险防闪烁）
try {
  const saved = localStorage.getItem('maharness-theme');
  const theme = saved === 'dark' || saved === 'light'
    ? saved
    : (typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.dataset.theme = theme;
  const brand = localStorage.getItem('maharness-brand');
  if (brand) document.documentElement.dataset.brand = brand;
} catch { /* 忽略 */ }

// Toaster 在 App 内挂载（theme 随主题切换，不再硬编码 dark）
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MotionConfig reducedMotion="user">
      <App />
    </MotionConfig>
  </React.StrictMode>,
);
