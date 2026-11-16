import {type ReactNode, useCallback, useEffect, useMemo, useState} from 'react';

import type {DiskUsageEntry, SystemStatus} from '../../../src/models/types';
import {
  type DiskUsageKind,
  type SystemFromWebview,
  type SystemToWebview,
  percentOf,
} from '../../../src/services/systemOverview';
import {formatBytes, formatPercent} from '../format';
import {useMessages} from '../useMessages';
import {locale, postMessage, t} from '../vscode';

type Update = Extract<SystemToWebview, {type: 'update'}>;

const send = (message: SystemFromWebview) => postMessage(message);

/** Replaces {0}, {1}, ... in a localized label */
const fill = (label: string, ...values: (string | number)[]) =>
  values.reduce<string>(
    (text, value, i) => text.split(`{${i}}`).join(String(value)),
    label,
  );

const KINDS: DiskUsageKind[] = ['images', 'containers', 'volumes'];

export function SystemView() {
  const [data, setData] = useState<Update>();
  const [loading, setLoading] = useState(true);

  useMessages(
    useCallback((message: SystemToWebview) => {
      if (message.type === 'loading') {
        setLoading(true);
      } else {
        setData(message);
        setLoading(false);
      }
    }, []),
  );

  useEffect(() => send({type: 'ready'}), []);

  const timeFormat = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }),
    [],
  );

  const status = data?.status;
  const usage = data?.usage;

  return (
    <div className="overview">
      <div className="overview-header">
        <h1>{t('title')}</h1>
        {status ? (
          <span className={`badge ${status.running ? 'ok' : 'off'}`}>
            {status.running ? t('running') : t('stopped')}
          </span>
        ) : null}
        <div className="spacer" />
        <button
          className="secondary"
          disabled={!status?.running}
          onClick={() => send({type: 'showJson'})}>
          {t('showJson')}
        </button>
        <button
          className="secondary"
          disabled={loading}
          onClick={() => send({type: 'refresh'})}>
          {t('refresh')}
        </button>
      </div>
      <div className="status muted">
        {loading
          ? t('loading')
          : data
            ? fill(t('updated'), timeFormat.format(data.updatedAt))
            : ''}
      </div>
      {data?.error ? <div className="status error">{data.error}</div> : null}

      {status && !status.running ? (
        <div className="card stopped">
          <span>{t('stoppedHint')}</span>
          <button onClick={() => send({type: 'start'})}>{t('start')}</button>
        </div>
      ) : null}

      {usage ? (
        <>
          <h2>{t('diskUsage')}</h2>
          <DiskTotal entries={KINDS.map(kind => usage[kind])} />
          <div className="usage-cards">
            {KINDS.map(kind => (
              <UsageCard
                key={kind}
                kind={kind}
                entry={usage[kind]}
                busy={loading}
              />
            ))}
          </div>
        </>
      ) : null}

      {status?.running ? <ServiceDetails status={status} /> : null}
    </div>
  );
}

function DiskTotal({entries}: {entries: DiskUsageEntry[]}) {
  const size = entries.reduce((sum, e) => sum + e.sizeBytes, 0);
  const reclaimable = entries.reduce((sum, e) => sum + e.reclaimableBytes, 0);
  return (
    <div className="muted usage-total">
      {t('total')} <strong>{formatBytes(size)}</strong> · {t('reclaimable')}{' '}
      <strong>{formatBytes(reclaimable)}</strong> (
      {formatPercent(percentOf(reclaimable, size))})
    </div>
  );
}

function UsageCard({
  kind,
  entry,
  busy,
}: {
  kind: DiskUsageKind;
  entry: DiskUsageEntry;
  busy: boolean;
}) {
  const percent = percentOf(entry.reclaimableBytes, entry.sizeBytes);
  return (
    <div className="card usage-card">
      <div className="usage-title">
        <span>{t(kind)}</span>
        <span className="muted">
          {fill(t('activeOfTotal'), entry.active, entry.total)}
        </span>
      </div>
      <div className="tile-value">{formatBytes(entry.sizeBytes)}</div>
      <div
        className="bar"
        role="meter"
        aria-label={t('reclaimable')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}>
        <div className="bar-fill" style={{width: `${percent}%`}} />
      </div>
      <div className="usage-footer">
        <span className="tile-sub muted">
          {t('reclaimable')} {formatBytes(entry.reclaimableBytes)} (
          {formatPercent(percent)})
        </span>
        <button
          className="secondary"
          disabled={busy || entry.total <= entry.active}
          onClick={() => send({type: 'prune', kind})}>
          {t('prune')}
        </button>
      </div>
    </div>
  );
}

function ServiceDetails({status}: {status: SystemStatus}) {
  const version =
    status.clientVersion === status.serverVersion
      ? status.serverVersion
      : `${t('client')} ${status.clientVersion ?? '–'} · ${t('server')} ${status.serverVersion ?? '–'}`;
  const rows: [string, string | undefined][] = [
    [t('version'), version],
    [
      t('containers'),
      status.containersTotal !== undefined
        ? fill(
            t('activeOfTotal'),
            status.containersRunning ?? 0,
            status.containersTotal,
          )
        : undefined,
    ],
    [t('images'), status.images?.toString()],
    [t('cpus'), status.hostCpus?.toString()],
    [t('os'), status.operatingSystem],
  ];
  const paths: [string, string | undefined][] = [
    [t('appRoot'), status.appRoot],
    [t('installRoot'), status.installRoot],
  ];
  return (
    <>
      <h2>{t('service')}</h2>
      <dl className="details">
        {rows
          .filter(([, value]) => value)
          .map(([label, value]) => (
            <Row key={label} label={label}>
              {value}
            </Row>
          ))}
      </dl>
      <h2>{t('paths')}</h2>
      <dl className="details">
        {paths
          .filter(([, value]) => value)
          .map(([label, value]) => (
            <Row key={label} label={label}>
              <code>{value}</code>
              <button
                className="icon"
                title={t('reveal')}
                onClick={() => send({type: 'reveal', path: value!})}>
                {t('reveal')}
              </button>
            </Row>
          ))}
      </dl>
    </>
  );
}

function Row({label, children}: {label: string; children: ReactNode}) {
  return (
    <>
      <dt className="muted">{label}</dt>
      <dd>{children}</dd>
    </>
  );
}
