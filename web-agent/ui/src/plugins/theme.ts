export function initializePluginTheme() {
  const apply = () => {
    try {
      const saved = localStorage.getItem('maharness-theme');
      const theme = saved === 'light' || saved === 'dark' ? saved : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      document.documentElement.dataset.theme = theme;
      document.documentElement.classList.toggle('dark', theme === 'dark');
      document.documentElement.dataset.brand = localStorage.getItem('maharness-brand') || 'doodle';
    } catch {}
  };
  apply();
  window.addEventListener('storage', apply);
}
