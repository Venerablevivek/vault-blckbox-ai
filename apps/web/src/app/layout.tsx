import type { Metadata } from 'next';
import { Providers } from '@/components/providers';
import { THEME_SCRIPT } from '@/components/theme';
import './globals.css';

export const metadata: Metadata = {
  title: 'Vault — File Storage & Sharing',
  description: 'Store documents, organise them in workspaces, and share them by revocable link.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // The theme class is set by THEME_SCRIPT before React hydrates, hence the warning suppression.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
