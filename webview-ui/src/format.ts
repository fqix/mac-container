export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export const formatRate = (bytes: number) => `${formatBytes(bytes)}/s`;

export const formatPercent = (value: number) => `${value.toFixed(value >= 10 ? 0 : 1)}%`;
