import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

// 首帧主题预置（与 index.html 内联脚本一致，双保险防闪烁）
try {
  document.documentElement.dataset.theme = localStorage.getItem('maharness-theme') === 'dark' ? 'dark' : 'light';
} catch { /* 忽略 */ }

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
