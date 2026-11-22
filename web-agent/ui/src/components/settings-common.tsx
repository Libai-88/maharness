// ui/src/components/settings-common.tsx —— 设置面板共用的小构件与常量
import { Check, ShieldAlert } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import type { ProviderForm } from '../types';

export function SettingsHeading({ title, description, children }: { title: string; description: string; children?: React.ReactNode }) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {children}
    </header>
  );
}

export function Notice({ ok = true, children }: { ok?: boolean; children: React.ReactNode }) {
  return (
    <Alert variant={ok ? 'default' : 'destructive'} role="status">
      {ok ? <Check /> : <ShieldAlert />}
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

export const EMPTY: ProviderForm = { label: '', baseUrl: '', apiKey: '', model: '', protocol: 'openai', priceIn: '', priceOut: '' };

export const PROVIDER_PRESETS: { label: string; baseUrl: string; model: string; protocol: string }[] = [
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', protocol: 'openai' },
  { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', protocol: 'openai' },
  { label: 'Anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5', protocol: 'anthropic' },
  { label: 'Ollama 本地', baseUrl: 'http://localhost:11434/v1', model: 'llama3.2', protocol: 'ollama' },
];
