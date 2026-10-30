import { useCallback, useEffect, useState } from 'react';

import type { BuildFromWebview, BuildOptions, BuildToWebview } from '../../../src/services/build';
import { useMessages } from '../useMessages';
import { postMessage, t } from '../vscode';

const send = (message: BuildFromWebview) => postMessage(message);

interface Info {
  file: string;
  stages: string[];
  platforms: string[];
}

type Lists = Pick<BuildOptions, 'buildArgs' | 'secrets' | 'labels'>;

const lines = (text: string) => text.split('\n').map((line) => line.trim()).filter(Boolean);

/** Build form for a Dockerfile: tag, context, target stage, platforms, build arguments, secrets and labels */
export function BuildForm() {
  const [info, setInfo] = useState<Info>();
  const [tag, setTag] = useState('');
  const [context, setContext] = useState('');
  const [target, setTarget] = useState('');
  const [platforms, setPlatforms] = useState<string[]>([]);
  // Edited as text, one entry per line
  const [texts, setTexts] = useState<Record<keyof Lists, string>>({ buildArgs: '', secrets: '', labels: '' });
  const [flags, setFlags] = useState<Pick<BuildOptions, 'noCache' | 'pull' | 'ssh'>>({ noCache: false, pull: false, ssh: false });
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useMessages(
    useCallback((message: BuildToWebview) => {
      switch (message.type) {
        case 'init': {
          const { options } = message;
          // Keep a saved target that is no longer declared, so it stays visible and can be changed
          const stages = options.target && !message.stages.includes(options.target) ? [...message.stages, options.target] : message.stages;
          setInfo({ file: message.file, stages, platforms: [...new Set([...message.platforms, ...options.platforms])] });
          setTag(options.tag);
          setContext(options.context);
          setTarget(options.target);
          setPlatforms(options.platforms);
          setTexts({ buildArgs: options.buildArgs.join('\n'), secrets: options.secrets.join('\n'), labels: options.labels.join('\n') });
          setFlags({ noCache: options.noCache, pull: options.pull, ssh: options.ssh });
          break;
        }
        case 'contextPicked':
          setContext(message.path);
          break;
        case 'problems':
          setProblems(message.messages);
          break;
        case 'busy':
          setBusy(message.busy);
          if (message.busy) {
            setProblems([]);
          }
          break;
      }
    }, []),
  );

  // Ask for the initial data once the listener is in place
  useEffect(() => send({ type: 'ready' }), []);

  const togglePlatform = (platform: string, on: boolean) =>
    setPlatforms((list) => (on ? [...list, platform] : list.filter((p) => p !== platform)));

  const build = () => {
    setProblems([]);
    send({
      type: 'build',
      options: {
        tag: tag.trim(),
        context: context.trim(),
        target,
        platforms,
        buildArgs: lines(texts.buildArgs),
        secrets: lines(texts.secrets),
        labels: lines(texts.labels),
        ...flags,
      },
    });
  };

  if (!info) {
    return <div className="muted">…</div>;
  }

  const listField = (key: keyof Lists, placeholder: string) => (
    <>
      <h2>{t(key)}</h2>
      <textarea
        rows={Math.min(12, Math.max(2, texts[key].split('\n').length + 1))}
        spellCheck={false}
        placeholder={placeholder}
        value={texts[key]}
        disabled={busy}
        onChange={(e) => setTexts((s) => ({ ...s, [key]: e.target.value }))}
      />
      <small className="muted">{t(`${key}Hint`)}</small>
    </>
  );

  return (
    <div className="edit">
      <h1>
        {t('buildTitle')}: {info.file}
      </h1>

      <div className="fields">
        <label>
          <span>{t('tag')}</span>
          <input type="text" value={tag} disabled={busy} onChange={(e) => setTag(e.target.value)} />
        </label>
        <label>
          <span>{t('target')}</span>
          <select value={target} disabled={busy} onChange={(e) => setTarget(e.target.value)}>
            <option value="">{t('lastStage')}</option>
            {info.stages.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="wide">
          <span>{t('context')}</span>
          <div style={{ display: 'flex', gap: 4 }}>
            <input type="text" value={context} disabled={busy} onChange={(e) => setContext(e.target.value)} />
            <button className="secondary" disabled={busy} onClick={() => send({ type: 'pickContext', current: context.trim() })}>
              {t('browse')}
            </button>
          </div>
        </label>
      </div>

      <h2>{t('platforms')}</h2>
      <div className="checks">
        {info.platforms.map((p) => (
          <label key={p}>
            <input type="checkbox" checked={platforms.includes(p)} disabled={busy} onChange={(e) => togglePlatform(p, e.target.checked)} /> {p}
          </label>
        ))}
      </div>
      <small className="muted">{t('platformsHint')}</small>

      {listField('buildArgs', 'KEY=VALUE')}
      {listField('secrets', 'id=npm_token,env=NPM_TOKEN')}
      {listField('labels', 'KEY=VALUE')}

      <h2>{t('options')}</h2>
      <div className="checks" style={{ flexDirection: 'column' }}>
        {(['noCache', 'pull', 'ssh'] as const).map((key) => (
          <label key={key}>
            <input type="checkbox" checked={flags[key]} disabled={busy} onChange={(e) => setFlags((f) => ({ ...f, [key]: e.target.checked }))} />{' '}
            {t(key)}
          </label>
        ))}
      </div>

      {problems.length ? <div className="error" style={{ marginTop: 16 }}>{problems.join('\n')}</div> : null}
      {busy ? <div className="muted" style={{ marginTop: 16 }}>{t('building')}</div> : null}

      <div className="actions">
        <button disabled={busy} onClick={build}>
          {t('build')}
        </button>
        <button className="secondary" disabled={busy} onClick={() => send({ type: 'cancel' })}>
          {t('cancel')}
        </button>
      </div>
    </div>
  );
}
