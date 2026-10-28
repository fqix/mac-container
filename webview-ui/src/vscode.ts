// Wrapper around the VS Code webview API; acquireVsCodeApi may only be called once per webview

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const api = acquireVsCodeApi();

export function postMessage<T>(message: T): void {
  api.postMessage(message);
}

/** Localized strings passed by the extension host in <body data-labels> */
export const labels: Record<string, string> = JSON.parse(document.body.dataset.labels ?? '{}');

export const locale = document.body.dataset.locale || 'en';

export function t(key: string): string {
  return labels[key] ?? key;
}
