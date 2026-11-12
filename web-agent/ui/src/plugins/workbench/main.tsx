import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from '@/components/ui/sonner';
import { initializePluginTheme } from '../theme';
import Workbench from './Workbench';
import '@/index.css';

initializePluginTheme();
document.documentElement.lang = new URLSearchParams(location.search).get('lang') === 'en' ? 'en' : 'zh-CN';
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Workbench />
    <Toaster />
  </StrictMode>,
);
