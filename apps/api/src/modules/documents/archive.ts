import { PassThrough, type Readable } from 'node:stream';
import { ZipFile, type EndOptions } from 'yazl';
import type { FileStorage } from '../../storage/file-storage';
import type { ArchiveRow } from './documents.repo';

/** One file in a zip: where it goes inside the archive and where its bytes are. */
export interface ArchiveEntry {
  id: string;
  path: string;
  storageKey: string;
  size: number;
  mtime: Date;
}

export interface ArchivePlan {
  filename: string;
  entries: ArchiveEntry[];
  /** Files that were chosen but can't be handed out, and why. Listed in NOT-INCLUDED.txt. */
  skipped: Array<{ path: string; reason: string }>;
}

export const NOT_INCLUDED_NAME = 'NOT-INCLUDED.txt';

/**
 * Makes one path segment safe to extract anywhere: no separators, nothing Windows refuses,
 * no control characters, and never "." or ".." (which would let an entry escape the folder
 * it is extracted into).
 */
export function safeSegment(name: string): string {
  // eslint-disable-next-line no-control-regex
  let clean = name.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_').trim();
  // Windows drops trailing dots and spaces. Replacing them also turns "." and ".." into "_" and "__".
  clean = clean.replace(/[. ]+$/, (tail) => '_'.repeat(tail.length));
  return (clean || '_').slice(0, 255);
}

/**
 * Picks a path no earlier entry has, comparing case-insensitively because most desktops'
 * file systems do: "report.pdf", then "report (2).pdf", "report (3).pdf"...
 */
export function uniquePath(taken: Set<string>, path: string): string {
  let candidate = path;
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  const hasExtension = dot > slash + 1;
  const stem = hasExtension ? path.slice(0, dot) : path;
  const extension = hasExtension ? path.slice(dot) : '';
  for (let n = 2; taken.has(candidate.toLowerCase()); n += 1) candidate = `${stem} (${n})${extension}`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

/** Turns the chosen documents into archive entries, leaving out any the scan hasn't cleared. */
export function planArchive(filename: string, rows: ArchiveRow[]): ArchivePlan {
  const taken = new Set<string>([NOT_INCLUDED_NAME.toLowerCase()]);
  const entries: ArchiveEntry[] = [];
  const skipped: ArchivePlan['skipped'] = [];
  for (const row of rows) {
    const path = [...row.dir, row.filename].map(safeSegment).join('/');
    if (row.scan_status === 'pending') {
      skipped.push({ path, reason: 'still being checked for malware' });
    } else if (row.scan_status === 'infected') {
      skipped.push({ path, reason: 'malware was found in it' });
    } else {
      entries.push({
        id: row.id,
        path: uniquePath(taken, path),
        storageKey: row.storage_key,
        size: Number(row.size),
        mtime: row.created_at,
      });
    }
  }
  return { filename, entries, skipped };
}

function notIncludedText(skipped: ArchivePlan['skipped']): Buffer {
  const lines = [
    'These files were chosen but are not in this download:',
    '',
    ...skipped.map((s) => `- ${s.path} (${s.reason})`),
    '',
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8');
}

/**
 * Streams a zip of the plan straight from storage, one object at a time, so memory stays flat
 * however large the archive is. Entries are stored rather than deflated: the files people keep
 * here (PDFs, images, Office documents) are already compressed, and with every size known up
 * front the archive's exact length is too, which lets the browser show real progress.
 *
 * `size` is null when it can't be known in advance. `abort()` stops reading storage, for when
 * the client goes away mid-download.
 */
export async function createArchiveStream(
  plan: ArchivePlan,
  storage: FileStorage,
  logger: { error: (details: object, message: string) => void },
): Promise<{ stream: Readable; size: number | null; abort: () => void }> {
  const zip = new ZipFile();
  const output = new PassThrough();
  let current: Readable | null = null;
  let aborted = false;

  const fail = (error: unknown) => {
    logger.error({ err: error }, 'zip download failed part-way');
    current?.destroy();
    // The status line has gone out already; ending the stream early is the only signal left.
    output.destroy(error instanceof Error ? error : new Error(String(error)));
  };
  zip.on('error', fail);
  zip.outputStream.on('error', fail);
  zip.outputStream.pipe(output);

  for (const entry of plan.entries) {
    zip.addReadStreamLazy(entry.path, { size: entry.size, mtime: entry.mtime, compress: false }, (callback) => {
      if (aborted) {
        callback(new Error('download aborted'), undefined as never);
        return;
      }
      storage.download(entry.storageKey).then(
        (stream) => {
          current = stream;
          callback(null, stream);
        },
        (error: unknown) => callback(error, undefined as never),
      );
    });
  }
  if (plan.skipped.length > 0) {
    zip.addBuffer(notIncludedText(plan.skipped), NOT_INCLUDED_NAME, { compress: false, mtime: new Date() });
  }

  // yazl reports the archive's final length (or -1 when it can't be known); its type
  // definitions leave the argument out.
  const end = zip.end.bind(zip) as (options: EndOptions, calculatedTotalSize: (total: number) => void) => void;
  const size = await new Promise<number | null>((resolve) => {
    end({ forceZip64Format: false, comment: '' }, (total) => resolve(total >= 0 ? total : null));
  });

  return {
    stream: output,
    size,
    abort: () => {
      aborted = true;
      current?.destroy();
      output.destroy();
    },
  };
}
