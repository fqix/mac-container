import * as assert from 'assert';

import { archiveFileName, registryHost, schemeArgs } from '../../src/utils/registry';

describe('registry references', () => {
  it('finds the registry host the way Docker does', () => {
    assert.strictEqual(registryHost('alpine:latest'), undefined);
    assert.strictEqual(registryHost('library/alpine'), undefined);
    assert.strictEqual(registryHost('ghcr.io/org/app:1.0'), 'ghcr.io');
    assert.strictEqual(registryHost('localhost/app'), 'localhost');
    assert.strictEqual(registryHost('registry:5000/app'), 'registry:5000');
  });

  it('uses http for loopback registries and listed insecure ones only', () => {
    const http = ['--scheme', 'http'];
    assert.deepStrictEqual(schemeArgs('localhost:5000/app:1'), http);
    assert.deepStrictEqual(schemeArgs('127.0.0.1:5000/app'), http);
    assert.deepStrictEqual(schemeArgs('[::1]:5000/app'), http);
    assert.deepStrictEqual(schemeArgs('ghcr.io/org/app'), []);
    assert.deepStrictEqual(schemeArgs('alpine'), []);
    assert.deepStrictEqual(schemeArgs('nas.lan:5000/app', ['nas.lan']), http);
    assert.deepStrictEqual(schemeArgs('nas.lan:5000/app', ['nas.lan:5000']), http);
    assert.deepStrictEqual(schemeArgs('nas.lan:5001/app', ['nas.lan:5000']), []);
  });

  it('names image archives after the image', () => {
    assert.strictEqual(archiveFileName(['ghcr.io/org/app:1.0']), 'app_1.0.tar');
    assert.strictEqual(archiveFileName(['a', 'b']), 'images.tar');
  });
});
