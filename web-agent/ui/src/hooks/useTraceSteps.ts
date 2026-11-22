import { useCallback, useRef, useState } from 'react';
import type { TraceStep } from '../types';

const TRACE_MAX = 400;

export function useTraceSteps() {
  const [steps, setSteps] = useState<TraceStep[]>([]);
  const [open, setOpenState] = useState(false);
  const buffer = useRef<TraceStep[]>([]);
  const openRef = useRef(false);

  const setOpen = useCallback((value: boolean) => {
    openRef.current = value;
    setOpenState(value);
    if (value) setSteps(buffer.current);
  }, []);

  const record = useCallback((step: TraceStep) => {
    const previous = buffer.current;
    const index = previous.findIndex((item) => item.id === step.id);
    let next = index < 0 ? [...previous, step] : previous.map((item, itemIndex) => (itemIndex === index ? step : item));
    if (next.length > TRACE_MAX) {
      const parents = new Set(next.flatMap((item) => (item.parentId ? [item.parentId] : [])));
      let remaining = next.length - TRACE_MAX;
      next = next.filter((item) => {
        if (remaining > 0 && !parents.has(item.id)) {
          remaining--;
          return false;
        }
        return true;
      });
      if (remaining > 0) next = next.slice(remaining);
    }
    buffer.current = next;
    if (openRef.current) setSteps(next);
  }, []);

  const clear = useCallback(() => {
    buffer.current = [];
    setSteps([]);
  }, []);

  return { steps, open, setOpen, record, clear };
}
