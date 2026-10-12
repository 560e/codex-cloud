export type FileLink = { path: string; line?: number; column?: number };
export type ResolvedFileLink = FileLink & { directory: boolean };

// Recognize Markdown file destinations without enabling arbitrary URI schemes.
// Decode once; the server applies realpath/project-boundary checks afterwards.
export function parseFileLink(href: string): FileLink | null {
  let value = href.trim();
  if (
    !value ||
    value.startsWith('#') ||
    value.startsWith('//') ||
    value.startsWith('\\\\') ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    return null;
  const hash = value.indexOf('#');
  const fragment = hash < 0 ? '' : value.slice(hash + 1);
  if (hash >= 0) value = value.slice(0, hash);
  if (value.includes('?')) return null;
  if (/^file:/i.test(value)) {
    try {
      const url = new URL(value);
      if (url.hostname && url.hostname !== 'localhost') return null;
      value = url.pathname;
    } catch {
      return null;
    }
  }
  try {
    value = decodeURIComponent(value);
  } catch {
    return null;
  }
  value = value.replaceAll('\\', '/');
  if (/^\/[a-z]:\//i.test(value)) value = value.slice(1);
  if (!value || value.startsWith('//') || /[\x00-\x1f\x7f]/.test(value)) return null;
  if (/^(?:https?|mailto|javascript|vbscript|data|blob|command|vscode|codex):/i.test(value))
    return null;
  const suffix = /:(\d+)(?::(\d+))?$/.exec(value);
  const anchor = /^L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?$/i.exec(fragment);
  if (suffix) value = value.slice(0, suffix.index);
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:\//i.test(value)) return null;
  const location = anchor || suffix;
  if (!value) return null;
  const line = location ? Number(location[1]) : undefined;
  const column = location?.[2] ? Number(location[2]) : undefined;
  if (
    [line, column].some(
      (n) => n !== undefined && (!Number.isSafeInteger(n) || n < 1 || n > 10000000),
    )
  )
    return null;
  return { path: value, ...(line ? { line } : {}), ...(column ? { column } : {}) };
}
