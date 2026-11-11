// Text helpers for the step terminal (src/ui/stepTerminal.ts); no vscode dependency

/** Elapsed time as the step lines show it: 850ms, 35s, 3m40s, 1h02m */
export function formatElapsed(ms: number): string {
  if (ms < 1000) {
    return `${Math.max(0, Math.round(ms))}ms`;
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
  }
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

/** A pseudoterminal needs CRLF: a bare LF only moves the cursor down, so later lines would start mid-row */
export function toTerminalText(text: string): string {
  return text.replace(/\r?\n/g, '\r\n');
}
