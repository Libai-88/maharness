import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from '@/components/ui/sonner';
import { initializePluginTheme } from '../theme';
import TodoBoard from './TodoBoard';
import '@/index.css';

initializePluginTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TodoBoard />
    <Toaster theme={document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'} />
  </StrictMode>,
);
