import * as assert from 'assert';

import { buildImageArgs, defaultBuildOptions, parseStages, validateBuildOptions } from '../../src/services/build';

describe('image build', () => {
  it('builds arguments for every form field', () => {
    const args = buildImageArgs('/src/app/Dockerfile', {
      tag: 'app:dev',
      context: '/src/app',
      target: 'runtime',
      platforms: ['linux/arm64', 'linux/amd64'],
      buildArgs: ['VERSION=1.2', 'EMPTY='],
      secrets: ['id=npm,env=NPM_TOKEN', 'id=key,src=/tmp/key'],
      labels: ['org.opencontainers.image.source=https://example.com'],
      noCache: true,
      pull: true,
      ssh: true,
    });
    assert.deepStrictEqual(args, [
      'build', '--progress', 'plain', '--file', '/src/app/Dockerfile', '--tag', 'app:dev',
      '--target', 'runtime', '--platform', 'linux/arm64', '--platform', 'linux/amd64',
      '--build-arg', 'VERSION=1.2', '--build-arg', 'EMPTY=',
      '--secret', 'id=npm,env=NPM_TOKEN', '--secret', 'id=key,src=/tmp/key',
      '--label', 'org.opencontainers.image.source=https://example.com',
      '--no-cache', '--pull', '--ssh', 'default', '/src/app',
    ]);
  });

  it('keeps the plain build arguments when no option is set', () => {
    assert.deepStrictEqual(buildImageArgs('/src/Dockerfile', defaultBuildOptions('src:latest', '/src')), [
      'build', '--progress', 'plain', '--file', '/src/Dockerfile', '--tag', 'src:latest', '/src',
    ]);
  });

  it('parses named stages', () => {
    const dockerfile = [
      'FROM golang:1.25 AS build',
      'RUN go build',
      '  from --platform=$BUILDPLATFORM alpine as Tools',
      'FROM build AS test',
      'FROM scratch',
      'FROM alpine AS build',
      '# FROM alpine AS commented',
    ].join('\r\n');
    assert.deepStrictEqual(parseStages(dockerfile), ['build', 'Tools', 'test']);
  });

  it('validates options the way the CLI parses them', () => {
    const env = { NPM_TOKEN: 'x', npm: 'y' };
    const ok = { ...defaultBuildOptions('app:1', '/src'), buildArgs: ['A=1', 'B='], secrets: ['id=npm', 'id=t,env=NPM_TOKEN', 'id=f,src=/k'] };
    assert.deepStrictEqual(validateBuildOptions(ok, env), []);

    const bad = {
      ...defaultBuildOptions('app 1', 'relative'),
      target: 'a b',
      buildArgs: ['A=1', 'NOVALUE', '=x'],
      labels: ['k'],
      secrets: ['npm', 'id=a=b', 'id=missing', 'id=t,env=NOPE', 'id=f,src=', 'id=f,path=/k'],
      ssh: true,
    };
    assert.deepStrictEqual(validateBuildOptions(bad, env), [
      { section: 'tag', index: 0, reason: 'tag' },
      { section: 'context', index: 0, reason: 'context' },
      { section: 'target', index: 0, reason: 'target' },
      { section: 'buildArgs', index: 1, reason: 'keyValue' },
      { section: 'buildArgs', index: 2, reason: 'keyValue' },
      { section: 'labels', index: 0, reason: 'keyValue' },
      { section: 'secrets', index: 0, reason: 'secretId' },
      { section: 'secrets', index: 1, reason: 'secretId' },
      { section: 'secrets', index: 2, reason: 'secretEnv', name: 'missing' },
      { section: 'secrets', index: 3, reason: 'secretEnv', name: 'NOPE' },
      { section: 'secrets', index: 4, reason: 'secretValue' },
      { section: 'secrets', index: 5, reason: 'secretValue' },
      { section: 'ssh', index: 0, reason: 'sshAgent' },
    ]);
    assert.deepStrictEqual(validateBuildOptions({ ...ok, ssh: true }, { ...env, SSH_AUTH_SOCK: '/tmp/agent' }), []);
  });
});
