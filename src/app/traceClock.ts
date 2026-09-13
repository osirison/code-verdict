/**
 * The one time-of-day formatter both trace channels prefix every line with (`apiTrace.ts`,
 * `agentTrace.ts`, and `extension.ts`'s own lines into the shared Agent Trace channel — the
 * build-identity line at activation and the run-diagnostics report copy). One shared function so
 * the three destinations render an identical format: the whole point is that a reviewer can line
 * up what one channel shows against another, and against what they watched happen on screen, by
 * eye — a format that drifted between files would defeat that.
 *
 * Local wall-clock time, with milliseconds, `HH:MM:SS.mmm` — never a UTC `toISOString()` (which
 * buries the useful part behind a date and a `Z` the reader has to mentally convert) and never
 * elapsed-since-start (which cannot be lined up against a wall-clock event the reviewer watched
 * happen outside the extension, e.g. a spinner or a host-side rate limit reset). Built from
 * `Date`'s own local-time accessors, not a locale-formatting API, so the shape never depends on
 * the runtime's configured locale.
 *
 * Pure and stateless: every caller passes an epoch-millisecond reading from its own injected
 * clock. This module never reads a wall clock itself.
 */
export function formatTimeOfDay(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}
