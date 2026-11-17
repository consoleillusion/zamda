// Turns MRT RIB records into one route per IPv4 prefix: the reference dataset.
//
// A route collector hears each prefix from many peers. The dataset keeps one
// row per prefix: the entry with the shortest AS path, ties broken by the lowest
// peer index, so the result is deterministic for a given dump. Prefixes whose
// chosen path has no single origin AS (empty, or ending in an AS_SET) are
// skipped and counted.

import type { RibRecord } from './mrt';

export interface RouteColumns {
  readonly prefixAddr: Uint32Array;
  readonly prefixLen: Uint8Array;
  readonly originAs: Uint32Array;
  readonly pathLen: Uint8Array;
  readonly rowCount: number;
}

export interface BuildStats {
  prefixesSeen: number;
  skippedNoOrigin: number;
  // Path lengths over 255 are stored as 255.
  pathsClamped: number;
}

export class RouteBuilder {
  private prefixAddr = new Uint32Array(1 << 16);
  private prefixLen = new Uint8Array(1 << 16);
  private originAs = new Uint32Array(1 << 16);
  private pathLen = new Uint8Array(1 << 16);
  private count = 0;
  readonly stats: BuildStats = { prefixesSeen: 0, skippedNoOrigin: 0, pathsClamped: 0 };

  add(record: RibRecord): void {
    // Purpose: choose this prefix's route and append it as a row
    this.stats.prefixesSeen++;
    let best: { pathLength: number; originAs: number | null; peerIndex: number } | null = null;
    for (const entry of record.entries) {
      if (
        !best ||
        entry.pathLength < best.pathLength ||
        (entry.pathLength === best.pathLength && entry.peerIndex < best.peerIndex)
      ) {
        best = entry;
      }
    }
    if (!best || best.originAs === null) {
      this.stats.skippedNoOrigin++;
      return;
    }
    this.reserve(this.count + 1);
    this.prefixAddr[this.count] = record.prefix;
    this.prefixLen[this.count] = record.prefixLength;
    this.originAs[this.count] = best.originAs;
    if (best.pathLength > 255) this.stats.pathsClamped++;
    this.pathLen[this.count] = Math.min(best.pathLength, 255);
    this.count++;
  }

  finish(): RouteColumns {
    // Purpose: the collected rows, trimmed to length
    return {
      prefixAddr: this.prefixAddr.slice(0, this.count),
      prefixLen: this.prefixLen.slice(0, this.count),
      originAs: this.originAs.slice(0, this.count),
      pathLen: this.pathLen.slice(0, this.count),
      rowCount: this.count,
    };
  }

  private reserve(size: number): void {
    // Purpose: double the column arrays when they are full
    if (size <= this.prefixAddr.length) return;
    const capacity = this.prefixAddr.length * 2;
    const grow = function <A extends Uint32Array | Uint8Array>(array: A): A {
      // Purpose: copy an array into one of double capacity
      const next = new (array.constructor as new (n: number) => A)(capacity);
      next.set(array);
      return next;
    };
    this.prefixAddr = grow(this.prefixAddr);
    this.prefixLen = grow(this.prefixLen);
    this.originAs = grow(this.originAs);
    this.pathLen = grow(this.pathLen);
  }
}
