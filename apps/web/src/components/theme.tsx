'use client';

import { useEffect, useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';

export type ThemeChoice = 'system' | 'light' | 'dark';
export const THEME_KEY = 'vault:theme';

/**
 * Runs in <head> before the page paints, so a dark-theme visitor never sees a flash of the light
 * theme. Kept tiny and self-contained: it is inlined as a string.
 */
export const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem('${THEME_KEY}');var d=t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d)}catch(e){}})()`;

function readChoice(): ThemeChoice {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
}

function apply(choice: ThemeChoice) {
  const dark = choice === 'dark' || (choice === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}

/** System, light or dark. "System" follows the operating system, including when it changes. */
export function ThemeSwitch() {
  const [choice, setChoice] = useState<ThemeChoice>('system');

  useEffect(() => setChoice(readChoice()), []);

  useEffect(() => {
    apply(choice);
    if (choice !== 'system') return;
    const media = matchMedia('(prefers-color-scheme: dark)');
    const follow = () => apply('system');
    media.addEventListener('change', follow);
    return () => media.removeEventListener('change', follow);
  }, [choice]);

  function choose(next: ThemeChoice) {
    setChoice(next);
    try {
      if (next === 'system') localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, next);
    } catch {
      // Storage blocked: the choice still applies to this page.
    }
  }

  const options: Array<{ value: ThemeChoice; label: string; icon: typeof Sun }> = [
    { value: 'system', label: 'System theme', icon: Monitor },
    { value: 'light', label: 'Light theme', icon: Sun },
    { value: 'dark', label: 'Dark theme', icon: Moon },
  ];
  return (
    <div role="radiogroup" aria-label="Theme" className="flex rounded-lg border border-line bg-surface-sunken p-0.5">
      {options.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={choice === value}
          aria-label={label}
          title={label}
          onClick={() => choose(value)}
          className={`flex h-7 flex-1 items-center justify-center rounded-md transition-colors ${choice === value ? 'bg-surface text-ink shadow-card' : 'text-ink-subtle hover:text-ink'}`}
        >
          <Icon className="h-3.5 w-3.5" aria-hidden />
        </button>
      ))}
    </div>
  );
}
