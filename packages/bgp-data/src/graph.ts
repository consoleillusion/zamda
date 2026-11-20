// Builds the AS-adjacency graph from the same MRT dump as the route dataset.
//
// One route per prefix is chosen exactly as the route dataset chooses it: the
// shortest AS_PATH, ties broken by the lowest peer index. Only AS_SEQUENCE
// segments give edges, an AS_SET or confederation segment breaks the path,
// prepends are collapsed, and a directed pair counts at most once per prefix.
// Node weights count the chosen routes that contain an AS.

import type { RibGraphRecord } from './mrt';

export interface GraphNodeColumns {
  readonly asn: Uint32Array;
  readonly paths: Uint32Array;
  readonly origins: Uint32Array;
  readonly rowCount: number;
}

export interface GraphEdgeColumns {
  readonly from_as: Uint32Array;
  readonly to_as: Uint32Array;
  readonly prefixes: Uint32Array;
  readonly rowCount: number;
}

export interface GraphColumns {
  readonly nodes: GraphNodeColumns;
  readonly edges: GraphEdgeColumns;
}

export interface GraphStats {
  prefixesSeen: number;
  skippedNoOrigin: number;
  // Chosen routes that produced no edge after prepends were collapsed.
  routesWithoutEdges: number;
  // Directed pairs repeated across segments of one prefix.
  duplicatePrefixedPairs: number;
}

function edgeKey(from: number, to: number): string {
  // Purpose: a string key for a directed AS pair in the builder's maps
  return `${from}:${to}`;
}

function grown(array: Uint32Array, size: number): Uint32Array {
  // Purpose: copy a growable uint32 column into a larger one
  const next = new Uint32Array(size);
  next.set(array);
  return next;
}

export class GraphBuilder {
  private asn: Uint32Array = new Uint32Array(1 << 13);
  private paths: Uint32Array = new Uint32Array(1 << 13);
  private origins: Uint32Array = new Uint32Array(1 << 13);
  private nodeCount = 0;
  private from: Uint32Array = new Uint32Array(1 << 14);
  private to: Uint32Array = new Uint32Array(1 << 14);
  private prefixes: Uint32Array = new Uint32Array(1 << 14);
  private edgeCount = 0;
  private readonly nodeIndex = new Map<number, number>();
  private readonly edgeIndex = new Map<string, number>();
  private readonly seenEdges = new Set<string>();
  readonly stats: GraphStats = {
    prefixesSeen: 0,
    skippedNoOrigin: 0,
    routesWithoutEdges: 0,
    duplicatePrefixedPairs: 0,
  };

  add(record: RibGraphRecord): void {
    // Purpose: add one prefix's chosen path to the node and edge counts
    this.stats.prefixesSeen++;
    let best: RibGraphRecord['paths'][number] | null = null;
    for (const path of record.paths) {
      if (
        !best ||
        path.pathLength < best.pathLength ||
        (path.pathLength === best.pathLength && path.peerIndex < best.peerIndex)
      ) {
        best = path;
      }
    }
    if (!best || best.originAs === null) {
      this.stats.skippedNoOrigin++;
      return;
    }

    this.seenEdges.clear();
    let edgesHere = 0;
    for (const sequence of best.sequences) {
      const hops: number[] = [];
      for (const asn of sequence) {
        if (hops.length === 0 || hops[hops.length - 1] !== asn) hops.push(asn);
      }
      for (const asn of hops) this.ensureNode(asn);
      for (let i = 1; i < hops.length; i++) {
        const from = hops[i - 1]!;
        const to = hops[i]!;
        const key = edgeKey(from, to);
        if (this.seenEdges.has(key)) {
          this.stats.duplicatePrefixedPairs++;
          continue;
        }
        this.seenEdges.add(key);
        this.ensureEdge(from, to, key);
        edgesHere++;
      }
    }
    this.origins[this.ensureNode(best.originAs)]!++;
    if (edgesHere === 0) this.stats.routesWithoutEdges++;
  }

  finish(): GraphColumns {
    // Purpose: the collected nodes and edges, trimmed to length
    return {
      nodes: {
        asn: this.asn.slice(0, this.nodeCount),
        paths: this.paths.slice(0, this.nodeCount),
        origins: this.origins.slice(0, this.nodeCount),
        rowCount: this.nodeCount,
      },
      edges: {
        from_as: this.from.slice(0, this.edgeCount),
        to_as: this.to.slice(0, this.edgeCount),
        prefixes: this.prefixes.slice(0, this.edgeCount),
        rowCount: this.edgeCount,
      },
    };
  }

  private ensureNode(asn: number): number {
    // Purpose: the node index for an AS, counted once per prefix
    const existing = this.nodeIndex.get(asn);
    if (existing !== undefined) return existing;
    const index = this.nodeCount++;
    this.reserveNodes(index + 1);
    this.asn[index] = asn;
    this.paths[index] = 1;
    this.origins[index] = 0;
    this.nodeIndex.set(asn, index);
    return index;
  }

  private ensureEdge(from: number, to: number, key: string): void {
    // Purpose: add or weight one directed pair
    let index = this.edgeIndex.get(key);
    if (index === undefined) {
      index = this.edgeCount++;
      this.reserveEdges(index + 1);
      this.from[index] = from;
      this.to[index] = to;
      this.prefixes[index] = 0;
      this.edgeIndex.set(key, index);
    }
    this.prefixes[index]!++;
  }

  private reserveNodes(size: number): void {
    // Purpose: grow the node columns when they are full
    if (size <= this.asn.length) return;
    const capacity = Math.max(size, this.asn.length * 2);
    this.asn = grown(this.asn, capacity);
    this.paths = grown(this.paths, capacity);
    this.origins = grown(this.origins, capacity);
  }

  private reserveEdges(size: number): void {
    // Purpose: grow the edge columns when they are full
    if (size <= this.from.length) return;
    const capacity = Math.max(size, this.from.length * 2);
    this.from = grown(this.from, capacity);
    this.to = grown(this.to, capacity);
    this.prefixes = grown(this.prefixes, capacity);
  }
}
