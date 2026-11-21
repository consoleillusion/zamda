// RIS Live parsing keeps the addresses and full path needed for the physical-IP layer.

import { describe, expect, test } from 'bun:test';
import { parseRisMessage } from './live';

describe('RIS Live messages', () => {
  test('announcements retain the peer IP, next hop and full AS path', () => {
    const rows = parseRisMessage(JSON.stringify({
      type: 'ris_message',
      data: {
        type: 'UPDATE',
        timestamp: 1700000000.5,
        peer: '192.0.2.9',
        peer_asn: 1564,
        path: [1564, [42, 43], 3356],
        announcements: [{ next_hop: '192.0.2.9', prefixes: ['203.0.113.0/24', '198.51.100.0/24'] }],
        withdrawals: [],
      },
    }));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      second: 1700000000,
      kind: 0,
      prefix_addr: 0xcb007100,
      prefix_len: 24,
      origin_as: 3356,
      peer_as: 1564,
      path_len: 3,
      peer_ip: '192.0.2.9',
      local_ip: null,
      next_hop: '192.0.2.9',
      as_path: '1564 {42 43} 3356',
    });
  });

  test('withdrawals keep the peer IP but have no next hop or path', () => {
    const rows = parseRisMessage(JSON.stringify({
      type: 'ris_message',
      data: { type: 'UPDATE', timestamp: 1700000001, peer_ip: '2001:db8::1', peer_asn: 1564, withdrawals: ['203.0.113.0/24'] },
    }));
    expect(rows).toEqual([{
      second: 1700000001,
      kind: 1,
      prefix_addr: 0xcb007100,
      prefix_len: 24,
      origin_as: 0,
      peer_as: 1564,
      path_len: 0,
      peer_ip: null,
      local_ip: null,
      next_hop: null,
      as_path: '',
    }]);
  });
});
