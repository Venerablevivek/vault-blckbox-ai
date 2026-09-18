import { AppError } from '../../lib/errors';

export type ScanStatus = 'pending' | 'clean' | 'infected' | 'unscanned';

/**
 * A document's bytes may leave storage (download, preview, share link) only once scanning allows
 * it. Pending files wait for the scanner; infected files never leave.
 */
export function assertScanAllows(document: { scan_status: ScanStatus }): void {
  if (document.scan_status === 'pending') {
    throw new AppError(409, 'SCAN_PENDING', 'This file is still being checked for malware. Try again in a moment.');
  }
  if (document.scan_status === 'infected') {
    throw new AppError(410, 'DOCUMENT_QUARANTINED', 'Malware was found in this file, so it has been removed.');
  }
}

/** The status a newly stored file starts with. */
export function initialScanStatus(scanMode: 'off' | 'clamav', size: number, maxBytes: number): ScanStatus {
  if (scanMode === 'off' || size > maxBytes) return 'unscanned';
  return 'pending';
}
