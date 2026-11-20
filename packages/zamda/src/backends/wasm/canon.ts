// Canonical ids for strings (D-063). The engine never sees strings: a utf8 or
// dictionary column is codes, and each segment has its own dictionary. Before a
// run, the host numbers every distinct string across all of a snapshot's string
// columns in code-point order (C-STR-ORDER) and gives the engine, for each
// segment and column, the map from its codes to those ids. Equal strings then
// have equal ids, whatever segment or column they came from, and ids order like
// the strings, so the engine can group, count distinct, take min and max, and
// later sort and compare strings as integers. Results hold ids; `strings[id]`
// turns them back.

import { compareStrings } from '../js/kernel-util';
import type { EngineSnapshot } from './store';

export interface Canon {
  // Every distinct string, in code-point order; the id of a string is its position.
  readonly strings: readonly string[];
  // The id of each code, by segment index and column index; absent for columns that hold no strings.
  readonly maps: ReadonlyMap<number, ReadonlyMap<number, Uint32Array>>;
}

export function buildCanon(snapshot: EngineSnapshot, columns: readonly number[]): Canon {
  // Purpose: number the strings of the given columns across every segment of a snapshot
  // Segments often share one dictionary (a table loaded in pieces, a keyed table's blocks), so each
  // distinct dictionary is read and mapped once, however many segments use it.
  const distinct = new Set<string>();
  const read = new Set<readonly string[]>();
  for (const segment of snapshot.segments) {
    for (const c of columns) {
      const dictionary = segment.dictionaries[c];
      if (!dictionary || read.has(dictionary)) continue;
      read.add(dictionary);
      for (const s of dictionary) distinct.add(s);
    }
  }
  const strings = [...distinct].sort(compareStrings);
  const ids = new Map<string, number>();
  strings.forEach((s, i) => ids.set(s, i));
  const maps = new Map<number, Map<number, Uint32Array>>();
  const mapped = new Map<readonly string[], Uint32Array>();
  snapshot.segments.forEach((segment, index) => {
    const byColumn = new Map<number, Uint32Array>();
    for (const c of columns) {
      const dictionary = segment.dictionaries[c];
      if (!dictionary) continue;
      let map = mapped.get(dictionary);
      if (map === undefined) mapped.set(dictionary, (map = Uint32Array.from(dictionary, s => ids.get(s)!)));
      byColumn.set(c, map);
    }
    maps.set(index, byColumn);
  });
  return { strings, maps };
}
