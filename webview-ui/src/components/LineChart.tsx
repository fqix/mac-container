import {
  CategoryScale,
  Chart as ChartJS,
  type ChartData,
  type ChartOptions,
  Filler,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip,
} from 'chart.js';
import { useMemo } from 'react';
import { Line } from 'react-chartjs-2';

import { useTheme, withAlpha } from '../useTheme';

ChartJS.register(LineElement, PointElement, LinearScale, CategoryScale, Filler, Legend, Tooltip);

export interface Series {
  label: string;
  /** null leaves a gap, e.g. rates of the first reading */
  data: (number | null)[];
  /** Key of a theme color, e.g. 'blue' */
  color: 'blue' | 'green' | 'orange' | 'purple' | 'red';
  fill?: boolean;
  dashed?: boolean;
}

interface Props {
  title: string;
  labels: string[];
  series: Series[];
  format: (value: number) => string;
  suggestedMax?: number;
}

export function LineChart({ title, labels, series, format, suggestedMax }: Props) {
  const theme = useTheme();

  const data = useMemo<ChartData<'line', (number | null)[], string>>(
    () => ({
      labels,
      datasets: series.map((s) => ({
        label: s.label,
        data: s.data,
        fill: s.fill ?? true,
        borderColor: theme[s.color],
        backgroundColor: withAlpha(theme[s.color], 0.15),
        borderWidth: 1.5,
        borderDash: s.dashed ? [4, 4] : undefined,
        pointRadius: 0,
        tension: 0.25,
      })),
    }),
    [labels, series, theme],
  );

  const options = useMemo<ChartOptions<'line'>>(
    () => ({
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          ticks: { maxTicksLimit: 6, maxRotation: 0, color: theme.muted },
          grid: { color: withAlpha(theme.grid, 0.4) },
          border: { color: theme.grid },
        },
        y: {
          beginAtZero: true,
          suggestedMax,
          ticks: { maxTicksLimit: 5, color: theme.muted, callback: (v) => format(Number(v)) },
          grid: { color: withAlpha(theme.grid, 0.4) },
          border: { color: theme.grid },
        },
      },
      plugins: {
        legend: { display: series.length > 1, labels: { boxWidth: 12, boxHeight: 2, color: theme.foreground } },
        tooltip: { callbacks: { label: (item) => `${item.dataset.label}: ${format(Number(item.raw))}` } },
      },
    }),
    [format, series.length, suggestedMax, theme],
  );

  return (
    <div className="card">
      <h2>{title}</h2>
      <div className="chart-canvas">
        <Line data={data} options={options} />
      </div>
    </div>
  );
}
