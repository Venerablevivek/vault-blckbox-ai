'use client';

import { useEffect, useState } from 'react';

/**
 * Minimal toast system.
 *
 * A module-level subscriber list rather than a context provider: any module can call
 * `toast()` without the component tree having to thread a provider through it, and there
 * is nothing to configure. Toasts are for confirmations only — anything the user has to
 * act on goes inline, where it cannot scroll away.
 */
export type ToastTone = 'info' | 'success' | 'error';

interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
}

type Listener = (toasts: Toast[]) => void;

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<Listener>();

function emit() {
  for (const listener of listeners) listener([...toasts]);
}

export function toast(message: string, tone: ToastTone = 'info'): void {
  const item = { id: nextId++, message, tone };
  toasts = [...toasts, item];
  emit();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== item.id);
    emit();
  }, 4000);
}

const TONES: Record<ToastTone, string> = {
  info: 'bg-ink text-canvas',
  // In the dark theme the state colours are light (for text), so toasts use deep ones.
  success: 'bg-ok text-white dark:bg-emerald-700',
  error: 'bg-danger text-white dark:bg-rose-700',
};

export function Toaster() {
  const [items, setItems] = useState<Toast[]>([]);

  useEffect(() => {
    listeners.add(setItems);
    return () => {
      listeners.delete(setItems);
    };
  }, []);

  if (items.length === 0) return null;

  return (
    <div
      className="pointer-events-none fixed bottom-6 right-6 z-50 flex flex-col items-end gap-2"
      role="status"
      aria-live="polite"
    >
      {items.map((item) => (
        <div
          key={item.id}
          className={`animate-rise rounded-lg px-4 py-2.5 text-sm font-medium shadow-lift ${TONES[item.tone]}`}
        >
          {item.message}
        </div>
      ))}
    </div>
  );
}
