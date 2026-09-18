import { describe, expect, it } from 'vitest';
import { NOT_INCLUDED_NAME, planArchive, safeSegment, uniquePath } from '../../src/modules/documents/archive';
import type { ArchiveRow } from '../../src/modules/documents/documents.repo';

const TAB = String.fromCharCode(9);
const NUL = String.fromCharCode(0);
const BACKSLASH = String.fromCharCode(92);

describe('zip entry names', () => {
  it('can never escape the folder the zip is extracted into', () => {
    expect(safeSegment('..')).toBe('__');
    expect(safeSegment('.')).toBe('_');
    expect(safeSegment('../../etc/passwd')).toBe('.._.._etc_passwd');
    expect(safeSegment(`a${BACKSLASH}b`)).toBe('a_b');
    expect(safeSegment('   ')).toBe('_');
  });

  it('replaces characters desktops refuse, and trailing dots and spaces', () => {
    expect(safeSegment('Q1: plan?*<>|".pdf')).toBe('Q1_ plan______.pdf');
    expect(safeSegment(`tab${TAB}here${NUL}`)).toBe('tab_here_');
    expect(safeSegment('notes. ')).toBe('notes_');
    expect(safeSegment('Relatório 2026 ✓.pdf')).toBe('Relatório 2026 ✓.pdf');
  });

  it('numbers duplicates before the extension, ignoring case', () => {
    const taken = new Set<string>();
    expect(uniquePath(taken, 'a/report.pdf')).toBe('a/report.pdf');
    expect(uniquePath(taken, 'a/Report.PDF')).toBe('a/Report (2).PDF');
    expect(uniquePath(taken, 'a/report.pdf')).toBe('a/report (3).pdf');
    expect(uniquePath(taken, 'b/report.pdf')).toBe('b/report.pdf');
    expect(uniquePath(taken, 'v1.2/README')).toBe('v1.2/README');
    expect(uniquePath(taken, 'v1.2/README')).toBe('v1.2/README (2)');
    expect(uniquePath(taken, '.env')).toBe('.env');
    expect(uniquePath(taken, '.env')).toBe('.env (2)');
  });

  it('leaves out files the scan has not cleared and never collides with the note about them', () => {
    const row = (filename: string, scan: ArchiveRow['scan_status'], dir: string[] = []): ArchiveRow => ({
      id: filename,
      filename,
      storage_key: `k/${filename}`,
      size: '10',
      scan_status: scan,
      created_at: new Date(0),
      dir,
    });
    const plan = planArchive('x.zip', [
      row('ok.pdf', 'clean'),
      row('old.pdf', 'unscanned', ['Old']),
      row('wait.pdf', 'pending'),
      row('bad.exe', 'infected', ['Sub']),
      row(NOT_INCLUDED_NAME, 'clean'),
    ]);
    expect(plan.entries.map((e) => e.path)).toEqual(['ok.pdf', 'Old/old.pdf', 'NOT-INCLUDED (2).txt']);
    expect(plan.skipped).toEqual([
      { path: 'wait.pdf', reason: 'still being checked for malware' },
      { path: 'Sub/bad.exe', reason: 'malware was found in it' },
    ]);
  });
});
