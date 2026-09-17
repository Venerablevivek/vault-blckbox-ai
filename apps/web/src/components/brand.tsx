import Link from 'next/link';

/**
 * Wordmark. The glyph is inline SVG rather than an image so it inherits colour, scales
 * cleanly and adds no request.
 */
export function Brand({ href = '/', compact = false }: { href?: string; compact?: boolean }) {
  return (
    <Link href={href} className="inline-flex items-center gap-2.5 group">
      <span className="relative inline-flex h-8 w-8 items-center justify-center rounded-[10px] bg-gradient-to-br from-brand-500 to-brand-700 shadow-sm">
        <svg viewBox="0 0 24 24" className="h-4 w-4 text-white" fill="none" aria-hidden="true">
          <path
            d="M4 7.5A2.5 2.5 0 0 1 6.5 5h3.2c.5 0 .98.2 1.33.55l1.1 1.1c.35.35.83.55 1.33.55h3.04A2.5 2.5 0 0 1 19 9.7v6.8a2.5 2.5 0 0 1-2.5 2.5h-10A2.5 2.5 0 0 1 4 16.5v-9Z"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
          <path d="M9 13h6M9 15.8h3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </span>
      {!compact ? (
        <span className="flex flex-col leading-none">
          <span className="text-[15px] font-semibold tracking-tight">Vault</span>
          <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-ink-subtle">
            Storage &amp; Sharing
          </span>
        </span>
      ) : null}
    </Link>
  );
}
