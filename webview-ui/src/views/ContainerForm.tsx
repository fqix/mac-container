import { useCallback, useEffect, useState } from 'react';

import type { ContainerSettings, FormFromWebview, FormToWebview } from '../../../src/services/containerSettings';
import type { ContainerMount, PortMapping } from '../../../src/models/types';
import { useMessages } from '../useMessages';
import { postMessage, t } from '../vscode';

const send = (message: FormFromWebview) => postMessage(message);

interface Info {
  mode: 'run' | 'edit';
  name: string;
  image: string;
  running: boolean;
  volumes: string[];
  networks: string[];
}

type Scalars = Pick<ContainerSettings, 'cpus' | 'memory' | 'user' | 'workdir'>;

const validPort = (n: number) => Number.isInteger(n) && n >= 1 && n <= 65535;

/** Run form for an image, or edit form for an existing container (applied by recreating it) */
export function ContainerForm() {
  const [info, setInfo] = useState<Info>();
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [ports, setPorts] = useState<PortMapping[]>([]);
  const [mounts, setMounts] = useState<ContainerMount[]>([]);
  // Edited as text, one entry per line, so .env content can be pasted
  const [envText, setEnvText] = useState('');
  const [networks, setNetworks] = useState<string[]>([]);
  const [scalars, setScalars] = useState<Scalars>({ cpus: '', memory: '', user: '', workdir: '' });
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useMessages(
    useCallback((message: FormToWebview) => {
      switch (message.type) {
        case 'init': {
          const { settings } = message;
          setInfo({
            mode: message.mode,
            name: message.name,
            image: message.image,
            running: message.running,
            volumes: message.volumes,
            // Keep networks the container uses even if they were deleted since
            networks: [...new Set([...message.networks, ...settings.networks])],
          });
          setName(message.mode === 'edit' ? message.name : '');
          setPorts(settings.ports);
          setMounts(settings.mounts);
          setEnvText(settings.env.join('\n'));
          setNetworks(settings.networks);
          setScalars({ cpus: settings.cpus, memory: settings.memory, user: settings.user, workdir: settings.workdir });
          break;
        }
        case 'envImported':
          setEnvText(message.env.join('\n'));
          break;
        case 'browsed':
          setMounts((list) => list.map((m, i) => (i === message.index ? { ...m, source: message.path } : m)));
          break;
        case 'problems':
          setProblems(message.messages);
          break;
        case 'busy':
          setBusy(message.busy);
          break;
      }
    }, []),
  );

  // Ask for the initial data once the listener is in place
  useEffect(() => send({ type: 'ready' }), []);

  const updatePort = (index: number, patch: Partial<PortMapping>) =>
    setPorts((list) => list.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  const updateMount = (index: number, patch: Partial<ContainerMount>) =>
    setMounts((list) => list.map((m, i) => (i === index ? { ...m, ...patch } : m)));

  const env = () => envText.split('\n').map((line) => line.trim()).filter(Boolean);
  const setScalar = (key: keyof Scalars, value: string) => setScalars((s) => ({ ...s, [key]: value.trim() }));
  const toggleNetwork = (network: string, on: boolean) =>
    setNetworks((list) => (on ? [...list, network] : list.filter((n) => n !== network)));

  const save = () => {
    setProblems([]);
    send({
      type: 'save',
      name: name.trim(),
      command: command.trim(),
      settings: { ports, mounts, env: env(), networks, ...scalars },
    });
  };

  if (!info) {
    return <div className="muted">…</div>;
  }
  const editing = info.mode === 'edit';

  return (
    <div className="edit">
      <h1>{editing ? `${t('editTitle')}: ${info.name}` : `${t('runTitle')}: ${info.image}`}</h1>
      {editing ? (
        <>
          <div className="muted">
            {t('image')}: {info.image} · {info.running ? t('running') : t('stopped')}
          </div>
          <p className="muted">{t('hint')}</p>
        </>
      ) : (
        <div className="fields">
          <label>
            <span>{t('name')}</span>
            <input type="text" placeholder={info.name || t('namePlaceholder')} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="wide">
            <span>{t('command')}</span>
            <input type="text" placeholder={t('commandPlaceholder')} value={command} onChange={(e) => setCommand(e.target.value)} />
            <small className="muted">{t('commandHint')}</small>
          </label>
        </div>
      )}

      <h2>{t('ports')}</h2>
      {ports.length ? (
        <table>
          <thead>
            <tr>
              <th>{t('hostAddress')}</th>
              <th>{t('hostPort')}</th>
              <th>{t('containerPort')}</th>
              <th>{t('protocol')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {ports.map((p, i) => (
              <tr key={i}>
                <td>
                  <input
                    type="text"
                    placeholder="0.0.0.0"
                    value={p.hostAddress === '0.0.0.0' ? '' : p.hostAddress}
                    onChange={(e) => updatePort(i, { hostAddress: e.target.value.trim() || '0.0.0.0' })}
                  />
                </td>
                <td className="col-narrow">
                  <PortInput value={p.hostPort} onChange={(hostPort) => updatePort(i, { hostPort })} />
                </td>
                <td className="col-narrow">
                  <PortInput value={p.containerPort} onChange={(containerPort) => updatePort(i, { containerPort })} />
                </td>
                <td className="col-narrow">
                  <select value={p.proto} onChange={(e) => updatePort(i, { proto: e.target.value })}>
                    <option value="tcp">TCP</option>
                    <option value="udp">UDP</option>
                  </select>
                </td>
                <td>
                  <RemoveButton onClick={() => setPorts((list) => list.filter((_, j) => j !== i))} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="muted">{t('noPorts')}</div>
      )}
      <div className="row">
        <button
          className="secondary"
          disabled={busy}
          onClick={() => setPorts((list) => [...list, { hostAddress: '0.0.0.0', hostPort: NaN, containerPort: NaN, proto: 'tcp' }])}
        >
          + {t('addPort')}
        </button>
      </div>

      <h2>{t('mounts')}</h2>
      {mounts.length ? (
        <table>
          <thead>
            <tr>
              <th>{t('type')}</th>
              <th>{t('source')}</th>
              <th>{t('destination')}</th>
              <th>{t('readOnly')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {mounts.map((m, i) => (
              <tr key={i}>
                <td className="col-select">
                  <select
                    value={m.kind}
                    onChange={(e) => updateMount(i, { kind: e.target.value, source: e.target.value === 'tmpfs' ? '' : m.source })}
                  >
                    <option value="volume">{t('volume')}</option>
                    <option value="bind">{t('bind')}</option>
                    <option value="tmpfs">tmpfs</option>
                  </select>
                </td>
                <td>
                  <MountSource mount={m} index={i} onChange={(source) => updateMount(i, { source })} />
                </td>
                <td>
                  <input type="text" placeholder="/data" value={m.destination} onChange={(e) => updateMount(i, { destination: e.target.value.trim() })} />
                </td>
                <td className="col-narrow">
                  <input
                    type="checkbox"
                    checked={m.readOnly}
                    disabled={m.kind === 'tmpfs'}
                    onChange={(e) => updateMount(i, { readOnly: e.target.checked })}
                  />
                </td>
                <td>
                  <RemoveButton onClick={() => setMounts((list) => list.filter((_, j) => j !== i))} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="muted">{t('noMounts')}</div>
      )}
      <div className="row">
        <button
          className="secondary"
          disabled={busy}
          onClick={() => setMounts((list) => [...list, { kind: 'volume', source: '', destination: '', readOnly: false }])}
        >
          + {t('addMount')}
        </button>
      </div>
      <datalist id="volume-names">
        {info.volumes.map((v) => (
          <option key={v} value={v} />
        ))}
      </datalist>

      <h2>{t('env')}</h2>
      <textarea
        rows={Math.min(12, Math.max(3, envText.split('\n').length + 1))}
        spellCheck={false}
        placeholder="KEY=VALUE"
        value={envText}
        onChange={(e) => setEnvText(e.target.value)}
      />
      <div className="row">
        <small className="muted" style={{ flex: 1 }}>
          {t('envHint')}
        </small>
        <button className="secondary" disabled={busy} onClick={() => send({ type: 'importEnv', env: env() })}>
          {t('importEnv')}
        </button>
      </div>

      <h2>{t('networks')}</h2>
      <div className="checks">
        {info.networks.map((n) => (
          <label key={n}>
            <input type="checkbox" checked={networks.includes(n)} onChange={(e) => toggleNetwork(n, e.target.checked)} /> {n}
          </label>
        ))}
      </div>
      <small className="muted">{t('networksHint')}</small>

      <h2>{t('resources')}</h2>
      <div className="fields">
        <label>
          <span>{t('cpus')}</span>
          <input type="number" min={1} placeholder={t('defaultValue')} value={scalars.cpus} onChange={(e) => setScalar('cpus', e.target.value)} />
        </label>
        <label>
          <span>{t('memory')}</span>
          <input type="text" placeholder={t('memoryPlaceholder')} value={scalars.memory} onChange={(e) => setScalar('memory', e.target.value)} />
        </label>
      </div>

      <h2>{t('process')}</h2>
      <div className="fields">
        <label>
          <span>{t('user')}</span>
          <input type="text" placeholder={t('userPlaceholder')} value={scalars.user} onChange={(e) => setScalar('user', e.target.value)} />
        </label>
        <label>
          <span>{t('workdir')}</span>
          <input type="text" placeholder={t('defaultValue')} value={scalars.workdir} onChange={(e) => setScalar('workdir', e.target.value)} />
        </label>
      </div>

      {problems.length ? <div className="error" style={{ marginTop: 16 }}>{problems.join('\n')}</div> : null}

      <div className="actions">
        <button disabled={busy} onClick={save}>
          {editing ? t('save') : t('run')}
        </button>
        <button className="secondary" disabled={busy} onClick={() => send({ type: 'cancel' })}>
          {t('cancel')}
        </button>
      </div>
    </div>
  );
}

function PortInput({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  return (
    <input
      type="number"
      min={1}
      max={65535}
      value={Number.isFinite(value) ? value : ''}
      aria-invalid={Number.isFinite(value) && !validPort(value)}
      onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))}
    />
  );
}

function MountSource({ mount, index, onChange }: { mount: ContainerMount; index: number; onChange: (source: string) => void }) {
  if (mount.kind === 'tmpfs') {
    return <span className="muted">tmpfs</span>;
  }
  if (mount.kind === 'bind') {
    return (
      <div style={{ display: 'flex', gap: 4 }}>
        <input type="text" placeholder={t('bindPlaceholder')} value={mount.source} onChange={(e) => onChange(e.target.value.trim())} />
        <button className="secondary" onClick={() => send({ type: 'browse', index })}>
          {t('browse')}
        </button>
      </div>
    );
  }
  return (
    <input
      type="text"
      list="volume-names"
      placeholder={t('volumePlaceholder')}
      value={mount.source}
      onChange={(e) => onChange(e.target.value.trim())}
    />
  );
}

function RemoveButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="icon" title={t('remove')} onClick={onClick}>
      ✕
    </button>
  );
}
