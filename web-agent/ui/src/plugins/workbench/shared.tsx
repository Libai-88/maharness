import { createContext, useContext } from 'react';
import type { Kind, WorkbenchState } from '../../../../plugins/workbench/model';
import type { WorkbenchStore } from './store';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '@/components/ui/empty';

export type Localize = (zh: string, en: string) => string;
export interface Editor {
  kind: Kind;
  id?: string;
}
export const WorkbenchContext = createContext<{
  store: WorkbenchStore;
  data: WorkbenchState;
  L: Localize;
  english: boolean;
  edit: (editor: Editor) => void;
  remove: (kind: Kind, ids: string[]) => void;
  confirm: (title: string, action: () => void, description?: string) => void;
  startPomo: (id: string) => void;
} | null>(null);
export function useWorkbench() {
  const value = useContext(WorkbenchContext);
  if (!value) throw new Error('Workbench context missing');
  return value;
}
export function Choice({
  value,
  onChange,
  label,
  options,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  options: [string, string][];
  disabled?: boolean;
}) {
  return (
    <Select value={value || '__empty'} onValueChange={(next) => onChange(next === '__empty' ? '' : next)} disabled={disabled}>
      <SelectTrigger aria-label={label} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {options.map(([key, name]) => (
            <SelectItem key={key || '__empty'} value={key || '__empty'}>
              {name}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
export function NoItems() {
  const { L } = useWorkbench();
  return (
    <Empty className="min-h-36">
      <EmptyHeader>
        <EmptyTitle>{L('暂无记录', 'No records')}</EmptyTitle>
        <EmptyDescription>{L('添加记录，或调整筛选条件。', 'Add a record or adjust your filters.')}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
export function download(content: string, filename: string, type = 'text/markdown;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
