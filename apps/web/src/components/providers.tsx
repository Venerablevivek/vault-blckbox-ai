'use client';

import type { ReactNode } from 'react';
import { DialogProvider } from './dialog';

/** Client-side providers shared by every page. */
export function Providers({ children }: { children: ReactNode }) {
  return <DialogProvider>{children}</DialogProvider>;
}
