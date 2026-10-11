/**
 * Where a post-auth redirect may go: a path on this site, never another
 * origin. `new URL(next, base)` happily resolves `https://evil`, `//evil`
 * and `/\evil` (browsers treat a backslash as a slash) off-site, so the raw
 * `next` parameter is only trusted after it resolves back to `base`'s origin.
 */
export function safeNextPath(next: string | null, base: string, fallback: string): string {
  if (!next || next.length > 2048) return fallback;
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback;
  // Control characters (tab, newline) are stripped by URL parsers and can
  // turn "/\t/evil" into "//evil".
  if (/[\u0000-\u001f\u007f]/.test(next)) return fallback;
  try {
    const origin = new URL(base).origin;
    const resolved = new URL(next, origin);
    if (resolved.origin !== origin) return fallback;
    return resolved.pathname + resolved.search + resolved.hash;
  } catch {
    return fallback;
  }
}
