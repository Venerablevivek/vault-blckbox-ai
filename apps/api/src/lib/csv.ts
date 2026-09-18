/**
 * CSV for spreadsheet software. Cells that start with = + - @ (or a tab or carriage return) are
 * prefixed with an apostrophe: spreadsheets run such cells as formulas, and audit data contains
 * text other people chose (file names, email addresses).
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvRow(values: Array<string | number | null | undefined>): string {
  return `${values.map(csvCell).join(',')}\r\n`;
}

/** A byte-order mark, so spreadsheet software reads the file as UTF-8. */
export const CSV_BOM = '\uFEFF';
