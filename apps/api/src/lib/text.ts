/**
 * Removes ASCII control characters (NUL through US, and DEL). Names and user agents are shown
 * in the UI, written to logs and put in Content-Disposition headers, where a stray newline or
 * NUL causes anything from broken layout to header injection.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/g;

export function stripControlCharacters(value: string): string {
  return value.replace(CONTROL_CHARACTERS, '');
}
