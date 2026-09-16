import { describe, expect, it } from 'vitest';
import { assertAllowedType } from '../../src/lib/mime';
import { AppError } from '../../src/lib/errors';

const PDF = Buffer.from('%PDF-1.4 hello');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const EXE = Buffer.from([0x4d, 0x5a, 0x90, 0x00]);

describe('upload type validation', () => {
  it('accepts an allowed type whose content matches', () => {
    expect(assertAllowedType('application/pdf', PDF)).toBe('application/pdf');
    expect(assertAllowedType('image/png', PNG)).toBe('image/png');
  });

  it('accepts text types by content shape', () => {
    expect(assertAllowedType('text/csv', Buffer.from('a,b\n1,2\n'))).toBe('text/csv');
  });

  it('rejects a disallowed type outright', () => {
    expect(() => assertAllowedType('application/x-msdownload', EXE)).toThrow(AppError);
    // SVG is excluded deliberately: it is an executable document.
    expect(() => assertAllowedType('image/svg+xml', Buffer.from('<svg/>'))).toThrow(/not allowed/);
  });

  it('rejects a file whose declared type contradicts its bytes', () => {
    // The classic bypass: rename evil.exe to invoice.pdf and declare application/pdf.
    expect(() => assertAllowedType('application/pdf', EXE)).toThrow(/does not match|not be recognised/);
    expect(() => assertAllowedType('image/png', PDF)).toThrow(AppError);
  });

  it('rejects binary content declared as text', () => {
    expect(() => assertAllowedType('text/plain', Buffer.from([0x00, 0x01, 0x02]))).toThrow(AppError);
  });
});
