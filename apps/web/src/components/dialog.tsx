'use client';

import { AlertTriangle, X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Accessible dialogs.
 *
 * Replaces the browser's prompt() and confirm(): those can't be styled, can't explain
 * consequences properly, and are blocked outright in some embedded browsers. Every dialog here:
 *   - traps Tab and Shift+Tab inside itself, so keyboard focus can't wander behind the overlay;
 *   - moves focus in when it opens and returns it to the element that opened it on close;
 *   - closes on Escape or a click on the backdrop;
 *   - is labelled (aria-modal, aria-labelledby, aria-describedby) for screen readers;
 *   - makes the rest of the page inert while open.
 */

/**
 * Open dialogs, innermost last. Only the top one handles Escape and Tab, so a confirmation
 * opened on top of another dialog (revoking a link from the share panel) owns the keyboard
 * until it closes, and focus returns to the dialog beneath it.
 */
const openStack: symbol[] = [];

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The keyboard and focus behaviour shared by every dialog: focus in on open, trap Tab, close
 * on Escape, make the page inert, and restore focus on close. Only the top-most dialog reacts.
 */
export function useDialogBehaviour(
  open: boolean,
  onClose: () => void,
  panel: React.RefObject<HTMLElement | null>,
  initialFocus?: string,
) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const self = Symbol('dialog');
    openStack.push(self);
    const opener = document.activeElement as HTMLElement | null;
    // Dialogs render in a portal outside #app-root, so the page can be made inert without
    // making the dialog itself inert.
    const root = document.getElementById('app-root');
    root?.setAttribute('inert', '');

    const focusFirst = () => {
      const node = panel.current;
      if (!node) return;
      const target =
        (initialFocus ? node.querySelector<HTMLElement>(initialFocus) : null) ??
        node.querySelector<HTMLElement>(FOCUSABLE) ??
        node;
      target.focus();
    };
    const frame = requestAnimationFrame(focusFirst);

    const onKeyDown = (event: KeyboardEvent) => {
      if (openStack[openStack.length - 1] !== self) return;
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !panel.current) return;
      const focusable = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (!panel.current.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);

    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKeyDown, true);
      openStack.splice(openStack.indexOf(self), 1);
      if (openStack.length === 0) root?.removeAttribute('inert');
      // Return focus to whatever opened the dialog, if it still exists.
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [open, initialFocus, panel]);
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  size = 'md',
  initialFocus,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** CSS selector inside the dialog to focus first; defaults to the first focusable element. */
  initialFocus?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const mounted = useMounted();
  useDialogBehaviour(open, onClose, panel, initialFocus);

  if (!open || !mounted) return null;

  const width = size === 'sm' ? 'max-w-sm' : size === 'lg' ? 'max-w-2xl' : 'max-w-lg';

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-ink/30 backdrop-blur-sm" aria-hidden onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={`panel relative max-h-[88vh] w-full ${width} animate-rise overflow-y-auto outline-none`}
      >
        <div className="flex items-start justify-between gap-4 px-6 pb-2 pt-5">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold">
              {title}
            </h2>
            {description ? (
              <div id={descriptionId} className="mt-1 text-sm text-ink-muted">
                {description}
              </div>
            ) : null}
          </div>
          <button className="btn-ghost -mr-2 -mt-1 h-8 px-2" onClick={onClose} aria-label="Close dialog">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-6 pb-6 pt-2">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------------------------------
 * Promise-based confirm and prompt, provided once at the root.
 * ------------------------------------------------------------------------------------------ */

interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  tone?: 'default' | 'danger';
}

interface PromptOptions {
  title: string;
  body?: ReactNode;
  label: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  /** Return an error message to block submission, or null when the value is acceptable. */
  validate?: (value: string) => string | null;
  maxLength?: number;
  tone?: 'default' | 'danger';
}

interface DialogApi {
  confirm(options: ConfirmOptions): Promise<boolean>;
  prompt(options: PromptOptions): Promise<string | null>;
}

const DialogContext = createContext<DialogApi | null>(null);

/** Portals need document.body, which only exists after the first client render. */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}

type Pending =
  | { kind: 'confirm'; options: ConfirmOptions; resolve: (value: boolean) => void }
  | { kind: 'prompt'; options: PromptOptions; resolve: (value: string | null) => void };

export function DialogProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const confirm = useCallback(
    (options: ConfirmOptions) => new Promise<boolean>((resolve) => setPending({ kind: 'confirm', options, resolve })),
    [],
  );
  const prompt = useCallback(
    (options: PromptOptions) =>
      new Promise<string | null>((resolve) => {
        setValue(options.defaultValue ?? '');
        setError(null);
        setPending({ kind: 'prompt', options, resolve });
      }),
    [],
  );

  function close(result: boolean | string | null) {
    if (!pending) return;
    if (pending.kind === 'confirm') pending.resolve(result === true);
    else pending.resolve(typeof result === 'string' ? result : null);
    setPending(null);
  }

  function submitPrompt(event: React.FormEvent) {
    event.preventDefault();
    if (pending?.kind !== 'prompt') return;
    const trimmed = value.trim();
    const problem = trimmed ? (pending.options.validate?.(trimmed) ?? null) : 'This field is required.';
    if (problem) {
      setError(problem);
      return;
    }
    close(trimmed);
  }

  const danger = pending?.kind === 'confirm' && pending.options.tone === 'danger';

  return (
    <DialogContext.Provider value={{ confirm, prompt }}>
      <div id="app-root">{children}</div>

      <Modal
        open={pending !== null}
        onClose={() => close(pending?.kind === 'confirm' ? false : null)}
        title={pending?.options.title ?? ''}
        size="sm"
        initialFocus={pending?.kind === 'prompt' ? 'input' : '[data-autofocus]'}
      >
        {pending?.kind === 'confirm' ? (
          <div>
            {pending.options.body ? (
              <div className={`flex gap-3 text-sm ${danger ? 'text-ink' : 'text-ink-muted'}`}>
                {danger ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden /> : null}
                <div>{pending.options.body}</div>
              </div>
            ) : null}
            <div className="mt-6 flex justify-end gap-2">
              <button className="btn-secondary" onClick={() => close(false)} data-autofocus>
                Cancel
              </button>
              <button className={danger ? 'btn-danger' : 'btn-primary'} onClick={() => close(true)}>
                {pending.options.confirmLabel ?? 'Confirm'}
              </button>
            </div>
          </div>
        ) : null}

        {pending?.kind === 'prompt' ? (
          <form onSubmit={submitPrompt} noValidate>
            {pending.options.body ? <div className="mb-3 text-sm text-ink-muted">{pending.options.body}</div> : null}
            <label className="label" htmlFor="dialog-prompt-input">
              {pending.options.label}
            </label>
            <input
              id="dialog-prompt-input"
              className="input"
              value={value}
              placeholder={pending.options.placeholder}
              maxLength={pending.options.maxLength ?? 255}
              onChange={(e) => {
                setValue(e.target.value);
                setError(null);
              }}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'dialog-prompt-error' : undefined}
              onFocus={(e) => e.currentTarget.select()}
            />
            {error ? (
              <p id="dialog-prompt-error" role="alert" className="mt-1.5 text-xs text-danger">
                {error}
              </p>
            ) : null}
            <div className="mt-6 flex justify-end gap-2">
              <button type="button" className="btn-secondary" onClick={() => close(null)}>
                Cancel
              </button>
              <button type="submit" className={pending.options.tone === 'danger' ? 'btn-danger' : 'btn-primary'}>
                {pending.options.confirmLabel ?? 'Save'}
              </button>
            </div>
          </form>
        ) : null}
      </Modal>
    </DialogContext.Provider>
  );
}

export function useDialogs(): DialogApi {
  const api = useContext(DialogContext);
  if (!api) throw new Error('useDialogs must be used inside <DialogProvider>');
  return api;
}
