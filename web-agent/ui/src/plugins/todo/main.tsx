import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from '@/components/ui/sonner';
import { initializePluginTheme } from '../theme';
import TodoBoard from './TodoBoard';
import PersonalItemsView from './PersonalItemsView';
import '@/index.css';

initializePluginTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {new URLSearchParams(location.search).has('history') ? <TodoBoard /> : <PersonalItemsView overview={new URLSearchParams(location.search).get('view') === 'overview'} />}
    <Toaster theme={document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'} />
  </StrictMode>,
);
