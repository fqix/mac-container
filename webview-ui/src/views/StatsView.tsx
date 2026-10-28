import { useCallback, useMemo, useState } from 'react';

import type { StatsMessage, StatsSample } from '../../../src/services/stats';
import { LineChart } from '../components/LineChart';
import { formatBytes, formatPercent, formatRate } from '../format';
import { useMessages } from '../useMessages';
import { locale, t } from '../vscode';

const MAX_POINTS = 90;

export function StatsView() {
  const [samples, setSamples] = useState<StatsSample[]>([]);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: '' });

  useMessages(
    useCallback((message: StatsMessage) => {
      if (message.type === 'sample') {
        setSamples((prev) => [...prev.slice(-(MAX_POINTS - 1)), message.sample]);
      } else {
        setStatus({ text: message.text, error: message.error });
      }
    }, []),
  );

  const timeFormat = useMemo(() => new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' }), []);
  const labels = useMemo(() => samples.map((s) => timeFormat.format(s.time)), [samples, timeFormat]);
  const pick = (key: keyof StatsSample) => samples.map((s) => s[key]);
  const last = samples[samples.length - 1];
  const show = (value: number | null | undefined, format: (v: number) => string) => (value === null || value === undefined ? '–' : format(value));

  return (
    <div>
      <h1>{document.body.dataset.container}</h1>
      <div className={`status ${status.error ? 'error' : 'muted'}`}>{status.text || (samples.length ? '' : t('waiting'))}</div>

      <div className="tiles">
        <Tile label={t('cpu')} value={show(last?.cpuPercent, formatPercent)} sub={t('cpuHint')} />
        <Tile
          label={t('memory')}
          value={last ? formatBytes(last.memoryBytes) : '–'}
          sub={
            last?.memoryLimitBytes
              ? `/ ${formatBytes(last.memoryLimitBytes)} (${formatPercent((last.memoryBytes / last.memoryLimitBytes) * 100)})`
              : ''
          }
        />
        <Tile label={t('network')} value={`↓ ${show(last?.rxBytesPerSec, formatRate)}`} sub={`↑ ${show(last?.txBytesPerSec, formatRate)}`} />
        <Tile label={t('block')} value={`R ${show(last?.readBytesPerSec, formatRate)}`} sub={`W ${show(last?.writeBytesPerSec, formatRate)}`} />
        <Tile label={t('processes')} value={last ? String(last.processes) : '–'} />
      </div>

      <div className="charts">
        <LineChart title={t('cpu')} labels={labels} format={formatPercent} suggestedMax={100} series={[{ label: t('cpu'), data: pick('cpuPercent'), color: 'blue' }]} />
        <LineChart
          title={t('memory')}
          labels={labels}
          format={formatBytes}
          series={[
            { label: t('memory'), data: pick('memoryBytes'), color: 'purple' },
            { label: t('limit'), data: pick('memoryLimitBytes'), color: 'red', fill: false, dashed: true },
          ]}
        />
        <LineChart
          title={t('network')}
          labels={labels}
          format={formatRate}
          series={[
            { label: t('received'), data: pick('rxBytesPerSec'), color: 'green' },
            { label: t('sent'), data: pick('txBytesPerSec'), color: 'orange' },
          ]}
        />
        <LineChart
          title={t('block')}
          labels={labels}
          format={formatRate}
          series={[
            { label: t('read'), data: pick('readBytesPerSec'), color: 'blue' },
            { label: t('write'), data: pick('writeBytesPerSec'), color: 'orange' },
          ]}
        />
      </div>
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card">
      <div className="muted">{label}</div>
      <div className="tile-value">{value}</div>
      {sub ? <div className="tile-sub muted">{sub}</div> : null}
    </div>
  );
}
