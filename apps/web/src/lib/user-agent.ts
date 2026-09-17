/**
 * "Chrome on macOS" from a user-agent string. Deliberately coarse: it only has to let a person
 * recognise their own devices, and the order of checks matters (Edge and Opera also say Chrome,
 * Chrome also says Safari).
 */
export function describeUserAgent(userAgent: string | null): { browser: string; os: string; mobile: boolean } {
  const ua = userAgent ?? '';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\/|CriOS\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : /curl|node|undici|axios|python/i.test(ua)
              ? 'Script or API client'
              : 'Unknown browser';
  const os = /iPhone|iPad|iPod/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X|Macintosh/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'unknown system';
  return { browser, os, mobile: /Mobile|iPhone|Android/.test(ua) };
}
