import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000' },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        // vendor 分 chunk：第三方库拆出独立文件（缓存友好 + 首屏并行加载），
        // 业务代码从 1.54MB 单体中脱离，消除 500kB 警告
        manualChunks: {
          // react 与业务代码共享模块图，强制拆分反而合并回主 chunk——交由 vite 自然处理
          'vendor-motion': ['motion'],
          'vendor-markdown': ['marked', 'dompurify', 'highlight.js'],
          'vendor-sonner': ['sonner'],
          'vendor-dnd': ['@dnd-kit/core', '@dnd-kit/sortable', '@dnd-kit/utilities'],
        },
      },
    },
  },
});
