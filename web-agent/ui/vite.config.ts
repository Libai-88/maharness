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
        // vendor 分 chunk：第三方库拆出独立文件（缓存友好 + 首屏并行加载）。
        // 函数形式精确匹配：object 形式 ['react-dom'] 只匹配包入口，
        // 而 react-dom 实际经 react-dom/client 深层导入（main.tsx/sonner）——
        // 不拆则整个 react-dom + scheduler 被吞进 vendor-sonner（约 +130kB），
        // 应用主 chunk 反向依赖 toast 库缓存，sonner 更新即击穿 react-dom 缓存
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined;
          if (/node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'vendor-react';
          if (/node_modules[\\/]motion(-dom|-utils)?[\\/]/.test(id) || /node_modules[\\/]framer-motion[\\/]/.test(id)) return 'vendor-motion';
          if (/node_modules[\\/](marked|dompurify|highlight\.js)[\\/]/.test(id)) return 'vendor-markdown';
          if (/node_modules[\\/]sonner[\\/]/.test(id)) return 'vendor-sonner';
          if (/node_modules[\\/]@dnd-kit[\\/]/.test(id)) return 'vendor-dnd';
          return undefined;
        },
      },
    },
  },
});
