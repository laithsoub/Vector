// Resolve a design token to its current computed value, for the few places a
// CSS variable cannot reach (iframe documents, canvas, exported files).
export function tokenValue(name: `--${string}`): string {
  if (typeof document === 'undefined') return '';
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
