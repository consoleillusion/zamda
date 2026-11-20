// The three tables the page holds, on both engines. Country and registry are small integer codes (255 =
// unknown) into lists that ship with the data, so grouping by them is integer work in either engine.

import { schema, t } from 'zamda';

export const NONE = 255;

// The routing table: one row per IPv4 prefix, kept current by announcements and withdrawals (keyed on
// prefix_addr + prefix_len). prefix_end and addresses are precomputed for the address lookup and for
// "how much address space" sums.
export const Routes = schema({
  prefix_addr: t.uint32,
  prefix_len: t.uint8,
  prefix_end: t.uint32,
  origin_as: t.uint32,
  path_len: t.uint8,
  cc: t.uint8,
  rir: t.uint8,
  addresses: t.float64,
});

// The update log: one row per prefix per BGP UPDATE. kind 0 = announce, 1 = withdraw. In the replay,
// `second` counts from the start of the recording; in live mode it is Unix time. pkey identifies a
// prefix exactly (addr * 64 + len) so distinct prefixes can be counted with one column.
export const Updates = schema({
  second: t.uint32,
  kind: t.uint8,
  prefix_addr: t.uint32,
  prefix_len: t.uint8,
  origin_as: t.uint32,
  peer_as: t.uint32,
  path_len: t.uint8,
  cc: t.uint8,
  pkey: t.float64,
});

export const ANNOUNCE = 0;
export const WITHDRAW = 1;
