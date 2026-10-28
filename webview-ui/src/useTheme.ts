import { useEffect, useState } from 'react';

export interface ThemeColors {
  foreground: string;
  muted: string;
  grid: string;
  blue: string;
  green: string;
  orange: string;
  purple: string;
  red: string;
}

function read(): ThemeColors {
  const style = getComputedStyle(document.body);
  const v = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    foreground: v('--vscode-foreground', '#cccccc'),
    muted: v('--vscode-descriptionForeground', '#999999'),
    grid: v('--vscode-editorWidget-border', '#80808040'),
    blue: v('--vscode-charts-blue', '#3794ff'),
    green: v('--vscode-charts-green', '#89d185'),
    orange: v('--vscode-charts-orange', '#d18616'),
    purple: v('--vscode-charts-purple', '#b180d7'),
    red: v('--vscode-charts-red', '#f14c4c'),
  };
}

/** VS Code theme colors; updates when the user switches theme (VS Code swaps classes on <body>) */
export function useTheme(): ThemeColors {
  const [colors, setColors] = useState(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setColors(read()));
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return colors;
}

/** #rrggbb -> rgba() with the given alpha; other color formats are returned unchanged */
export function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  if (!hex) {
    return color;
  }
  const n = parseInt(hex[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
