// Reference data for the benchmark harness: the routing-table file, sampled to
// several sizes, in the three forms the engines start from.
//
//   columns      typed arrays plus string arrays: what a loader or a WASM engine gets
//   row objects  an array of { prefix_addr, ... }: what JSON or an API gives you
//
// The harness times building a table from each form, because the spike gate
// counts the cost of loading JS rows.

import * as aq from 'arquero';
import type { ColumnTable } from 'arquero';
import { table } from '../../src';
import type { JsTable } from '../../src';
import { Routes } from '../../scripts/bgp/file';
import type { RouteArrays } from '../../scripts/bgp/file';

export type { RouteArrays };

export interface RouteRow {
  prefix_addr: number;
  prefix_len: number;
  origin_as: number;
  as_name: string | null;
  path_len: number;
  rir: string | null;
}

export function sample(arrays: RouteArrays, rows: number): RouteArrays {
  // Purpose: every k-th row, so a smaller size has the same mix as the whole file
  if (rows >= arrays.rowCount) return arrays;
  const stride = arrays.rowCount / rows;
  const pick = new Uint32Array(rows);
  for (let i = 0; i < rows; i++) pick[i] = Math.floor(i * stride);
  const u32 = function (from: Uint32Array): Uint32Array {
    // Purpose: gather the picked rows of a uint32 column
    return Uint32Array.from(pick, i => from[i]!);
  };
  const u8 = function (from: Uint8Array): Uint8Array {
    // Purpose: gather the picked rows of a uint8 column
    return Uint8Array.from(pick, i => from[i]!);
  };
  return {
    rowCount: rows,
    prefix_addr: u32(arrays.prefix_addr),
    prefix_len: u8(arrays.prefix_len),
    origin_as: u32(arrays.origin_as),
    as_name: Array.from(pick, i => arrays.as_name[i]!),
    path_len: u8(arrays.path_len),
    rir: Array.from(pick, i => arrays.rir[i]!),
  };
}

export function toRows(arrays: RouteArrays): RouteRow[] {
  // Purpose: the same data as an array of row objects
  const rows: RouteRow[] = new Array(arrays.rowCount);
  for (let i = 0; i < arrays.rowCount; i++) {
    rows[i] = {
      prefix_addr: arrays.prefix_addr[i]!,
      prefix_len: arrays.prefix_len[i]!,
      origin_as: arrays.origin_as[i]!,
      as_name: arrays.as_name[i]!,
      path_len: arrays.path_len[i]!,
      rir: arrays.rir[i]!,
    };
  }
  return rows;
}

export function zamdaFromColumns(arrays: RouteArrays): JsTable<typeof Routes.fields> {
  // Purpose: a zamda table built from columns
  return table(Routes, {
    columns: {
      prefix_addr: arrays.prefix_addr,
      prefix_len: arrays.prefix_len,
      origin_as: arrays.origin_as,
      as_name: arrays.as_name,
      path_len: arrays.path_len,
      rir: arrays.rir,
    },
  });
}

export function zamdaFromRows(rows: readonly RouteRow[]): JsTable<typeof Routes.fields> {
  // Purpose: a zamda table built from row objects, validating every value
  return table(Routes, rows);
}

export function arqueroFromColumns(arrays: RouteArrays): ColumnTable {
  // Purpose: an Arquero table built from columns
  return aq.table({
    prefix_addr: arrays.prefix_addr,
    prefix_len: arrays.prefix_len,
    origin_as: arrays.origin_as,
    as_name: arrays.as_name,
    path_len: arrays.path_len,
    rir: arrays.rir,
  });
}

export function arqueroFromRows(rows: readonly RouteRow[]): ColumnTable {
  // Purpose: an Arquero table built from row objects
  return aq.from(rows as RouteRow[]);
}
