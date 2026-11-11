import * as assert from 'assert';

import {containerPortUrl, parseListeningPorts} from '../../src/utils/ports';

// `cat /proc/net/tcp /proc/net/tcp6` in an alpine container (Apple container 1.6.1) with BusyBox nc listening on
// :::8080 and 127.0.0.1:9090, plus an established connection and synthetic rows for other addresses
const TABLES = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:2382 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2052 1 00000000e6ab94a6 100 0 0 10 0
   1: 0740A8C0:1F90 0140A8C0:D2F0 01 00000000:00000000 00:00000000 00000000     0        0 3080 1 0000000000000000 20 4 30 10 -1
   2: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2060 1 0000000000000000 100 0 0 10 0
   3: 0740A8C0:1538 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2061 1 0000000000000000 100 0 0 10 0
  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000000000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 3074 1 00000000883bca9f 100 0 0 10 0
   1: 00000000000000000000000001000000:0CEA 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 3075 1 0000000000000000 100 0 0 10 0
   2: 0000000000000000FFFF00000100007F:1F91 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 3076 1 0000000000000000 100 0 0 10 0
   3: B80D0120000000000000000001000000:0016 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 3077 1 0000000000000000 100 0 0 10 0
`;

describe('listening ports', () => {
  it('reads listening sockets from /proc/net/tcp and tcp6, merging addresses per port', () => {
    assert.deepStrictEqual(parseListeningPorts(TABLES), [
      // 0.0.0.0 and 2001:db8::1 for ssh
      {port: 22, addresses: ['0.0.0.0', '2001:db8::1'], reachable: true},
      {port: 3306, addresses: ['::1'], reachable: false},
      // Bound to the container's own address
      {port: 5432, addresses: ['192.168.64.7'], reachable: true},
      {port: 8080, addresses: ['::'], reachable: true},
      {port: 8081, addresses: ['::ffff:127.0.0.1'], reachable: false},
      {port: 9090, addresses: ['127.0.0.1'], reachable: false},
    ]);
  });

  it('ignores headers, non-listening sockets and malformed rows', () => {
    assert.deepStrictEqual(parseListeningPorts(''), []);
    assert.deepStrictEqual(
      parseListeningPorts(
        'garbage\n 0: XYZ:0000 0 0A\n 1: 00000000:0000 00000000:0000 0A',
      ),
      [],
    );
  });

  it('builds the URL through the container IP', () => {
    assert.strictEqual(
      containerPortUrl('192.168.64.7', 8080),
      'http://192.168.64.7:8080',
    );
  });
});
