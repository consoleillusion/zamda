// S-301 spike host: loads the Rust kernels (as WASM or as a native library) and
// exposes the gate queries Q1, Q3, Q4 and Q7 on top of them. Throwaway code.
//
// Nothing here imports Node or Bun, so it also runs in a browser; the native
// loader lives in native.ts.

export interface RawKernels {
  alloc(bytes: number): number;
  free(ptr: number, bytes: number): void;
  u8(ptr: number, length: number): Uint8Array;
  u32(ptr: number, length: number): Uint32Array;
  q1(n: number, origin: number, name: number, outAs: number, outName: number, outCount: number): number;
  q3(n: number, rir: number, origin: number, outRoutes: number, outNetworks: number): void;
  q4(n: number, origin: number, limit: number, outAs: number, outCount: number): number;
  q7(n: number, len: number, addr: number, outLen: number, outAddr: number, radix: number): void;
  mask(n: number, len: number, path: number, addr: number, rir: number, name: number, bounds: number, rirOk: number, nameOk: number, nameOkLen: number, out: number): void;
  cNetworks(n: number, mask: number, keep: number, origin: number, name: number, outAs: number, outName: number, outCount: number): number;
  cHist(n: number, mask: number, keep: number, column: number, out: number): void;
  cRegions(n: number, mask: number, keep: number, rir: number, origin: number, outRoutes: number, outNetworks: number): void;
  overflowed(): number;
}

export interface Columns {
  readonly rowCount: number;
  readonly prefix_addr: Uint32Array;
  readonly prefix_len: Uint8Array;
  readonly origin_as: Uint32Array;
  readonly as_name: readonly (string | null)[];
  readonly path_len: Uint8Array;
  readonly rir: readonly (string | null)[];
}

export interface RowLike {
  prefix_addr: number;
  prefix_len: number;
  origin_as: number;
  as_name: string | null;
  path_len: number;
  rir: string | null;
}

export async function loadWasm(bytes: BufferSource): Promise<RawKernels> {
  // Purpose: instantiate the spike module; pointers are offsets into its linear memory
  const { instance } = (await WebAssembly.instantiate(bytes, {})) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
  const e = instance.exports as unknown as Record<string, (...args: number[]) => number> & { memory: WebAssembly.Memory };
  return {
    alloc: bytes => e.zs_alloc!(bytes)!,
    free: (ptr, bytes) => void e.zs_free!(ptr, bytes),
    // Views are made on every call because memory.buffer is replaced when the memory grows.
    u8: (ptr, length) => new Uint8Array(e.memory.buffer, ptr, length),
    u32: (ptr, length) => new Uint32Array(e.memory.buffer, ptr, length),
    q1: (n, a, b, c, d, f) => e.zs_q1!(n, a, b, c, d, f)!,
    q3: (n, a, b, c, d) => void e.zs_q3!(n, a, b, c, d),
    q4: (n, a, l, c, d) => e.zs_q4!(n, a, l, c, d)!,
    q7: (n, a, b, c, d, r) => void e.zs_q7!(n, a, b, c, d, r),
    mask: (n, a, b, c, d, f, g, h, i, j, k) => void e.zs_mask!(n, a, b, c, d, f, g, h, i, j, k),
    cNetworks: (n, m, k, o, nm, a, b, c) => e.zs_c_networks!(n, m, k, o, nm, a, b, c)!,
    cHist: (n, m, k, col, out) => void e.zs_c_hist!(n, m, k, col, out),
    cRegions: (n, m, k, r, o, a, b) => void e.zs_c_regions!(n, m, k, r, o, a, b),
    overflowed: () => e.zs_overflowed!()!,
  };
}

export class Spike {
  private rows = 0;
  private ptrs: { addr: number; len: number; origin: number; name: number; pathLen: number; rir: number } | null = null;
  private out: { q1As: number; q1Name: number; q1Count: number; q7Len: number; q7Addr: number; mask: number } | null = null;
  private names = new Map<string | null, number>();
  private rirs = new Map<string | null, number>();
  nameList: (string | null)[] = [];
  rirList: (string | null)[] = [];

  constructor(private readonly k: RawKernels) {}

  private allocate(n: number): void {
    // Purpose: free what was loaded before, then reserve memory for `n` rows of every column and the result buffers
    this.release();
    this.rows = n;
    const k = this.k;
    this.ptrs = {
      addr: k.alloc(n * 4),
      len: k.alloc(n),
      origin: k.alloc(n * 4),
      name: k.alloc(n * 4),
      pathLen: k.alloc(n),
      rir: k.alloc(n),
    };
    this.out = { q1As: k.alloc(n * 4), q1Name: k.alloc(n * 4), q1Count: k.alloc(n * 4), q7Len: k.alloc(n), q7Addr: k.alloc(n * 4), mask: k.alloc(n) };
  }

  release(): void {
    // Purpose: give all memory back
    if (!this.ptrs || !this.out) return;
    const n = this.rows;
    const p = this.ptrs;
    const o = this.out;
    for (const [ptr, size] of [[p.addr, n * 4], [p.len, n], [p.origin, n * 4], [p.name, n * 4], [p.pathLen, n], [p.rir, n], [o.q1As, n * 4], [o.q1Name, n * 4], [o.q1Count, n * 4], [o.q7Len, n], [o.q7Addr, n * 4], [o.mask, n]] as const) {
      this.k.free(ptr, size);
    }
    this.ptrs = null;
    this.out = null;
  }

  private code(map: Map<string | null, number>, list: (string | null)[], value: string | null): number {
    // Purpose: the dictionary code of a string: 0 is null, then 1, 2, ... in order of first appearance
    if (value === null) return 0;
    let c = map.get(value);
    if (c === undefined) {
      c = list.length + 1;
      list.push(value);
      map.set(value, c);
    }
    return c;
  }

  loadColumns(c: Columns): void {
    // Purpose: copy typed columns into the module and dictionary-encode the two string columns
    this.allocate(c.rowCount);
    this.names.clear();
    this.rirs.clear();
    this.nameList = [];
    this.rirList = [];
    const n = c.rowCount;
    const p = this.ptrs!;
    this.k.u32(p.addr, n).set(c.prefix_addr);
    this.k.u8(p.len, n).set(c.prefix_len);
    this.k.u32(p.origin, n).set(c.origin_as);
    this.k.u8(p.pathLen, n).set(c.path_len);
    const name = this.k.u32(p.name, n);
    const rir = this.k.u8(p.rir, n);
    for (let i = 0; i < n; i++) {
      name[i] = this.code(this.names, this.nameList, c.as_name[i]!);
      rir[i] = this.code(this.rirs, this.rirList, c.rir[i]!);
    }
  }

  loadRows(rows: readonly RowLike[]): void {
    // Purpose: copy row objects into the module column by column, dictionary-encoding the strings: the cost the gate counts
    const n = rows.length;
    this.allocate(n);
    this.names.clear();
    this.rirs.clear();
    this.nameList = [];
    this.rirList = [];
    const p = this.ptrs!;
    const addr = this.k.u32(p.addr, n);
    const len = this.k.u8(p.len, n);
    const origin = this.k.u32(p.origin, n);
    const name = this.k.u32(p.name, n);
    const pathLen = this.k.u8(p.pathLen, n);
    const rir = this.k.u8(p.rir, n);
    for (let i = 0; i < n; i++) {
      const r = rows[i]!;
      addr[i] = r.prefix_addr;
      len[i] = r.prefix_len;
      origin[i] = r.origin_as;
      name[i] = this.code(this.names, this.nameList, r.as_name);
      pathLen[i] = r.path_len;
      rir[i] = this.code(this.rirs, this.rirList, r.rir);
    }
  }

  q1(): { origin_as: Uint32Array; name: Uint32Array; n: Uint32Array } {
    // Purpose: routes per network (origin_as and name code); the groups are copied out of module memory
    const p = this.ptrs!;
    const o = this.out!;
    const g = this.k.q1(this.rows, p.origin, p.name, o.q1As, o.q1Name, o.q1Count);
    this.check();
    return { origin_as: this.k.u32(o.q1As, g).slice(), name: this.k.u32(o.q1Name, g).slice(), n: this.k.u32(o.q1Count, g).slice() };
  }

  q3(): { routes: Uint32Array; networks: Uint32Array } {
    // Purpose: routes and distinct networks per region code
    const p = this.ptrs!;
    const buf = this.k.alloc(2048);
    this.k.q3(this.rows, p.rir, p.origin, buf, buf + 1024);
    this.check();
    const result = { routes: this.k.u32(buf, 256).slice(), networks: this.k.u32(buf + 1024, 256).slice() };
    this.k.free(buf, 2048);
    return result;
  }

  q4(limit = 20): { origin_as: Uint32Array; n: Uint32Array } {
    // Purpose: the `limit` networks with the most routes
    const p = this.ptrs!;
    const buf = this.k.alloc(limit * 8);
    const took = this.k.q4(this.rows, p.origin, limit, buf, buf + limit * 4);
    this.check();
    const result = { origin_as: this.k.u32(buf, took).slice(), n: this.k.u32(buf + limit * 4, took).slice() };
    this.k.free(buf, limit * 8);
    return result;
  }

  q7(radix: boolean): { prefix_len: Uint8Array; prefix_addr: Uint32Array } {
    // Purpose: every route sorted by prefix length then address; both columns are copied out
    const p = this.ptrs!;
    const o = this.out!;
    this.k.q7(this.rows, p.len, p.addr, o.q7Len, o.q7Addr, radix ? 1 : 0);
    return { prefix_len: this.k.u8(o.q7Len, this.rows).slice(), prefix_addr: this.k.u32(o.q7Addr, this.rows).slice() };
  }

  private lowerNames: string[] | null = null;
  private nameFlags = new Map<string, Uint8Array>();

  dashboard(selection: DashboardSelection): DashboardResult {
    // Purpose: one dashboard interaction: evaluate the five controls once into a per-row mask, then run the four charts over it
    const p = this.ptrs!;
    const o = this.out!;
    const n = this.rows;
    const k = this.k;
    const search = selection.search.trim().toLowerCase();
    // Which dictionary entries match the search: computed once per search text, like zamda's per-entry cache (D-045).
    let nameOk = this.nameFlags.get(search);
    if (!nameOk) {
      nameOk = new Uint8Array(this.nameList.length + 1);
      if (search === '') nameOk.fill(1);
      else {
        this.lowerNames ??= this.nameList.map(x => x!.toLowerCase());
        for (let c = 0; c < this.lowerNames.length; c++) nameOk[c + 1] = this.lowerNames[c]!.includes(search) ? 1 : 0;
      }
      this.nameFlags.set(search, nameOk);
    }
    const regionOk = new Uint8Array(256);
    if (selection.regions === null) regionOk.fill(1);
    else {
      for (const region of selection.regions) {
        const at = this.rirList.indexOf(region);
        if (at !== -1) regionOk[at + 1] = 1;
      }
    }
    const prefix = selection.prefixLen ?? [0, 255];
    const path = selection.pathLen ?? [0, 255];
    const addr = selection.addr ?? [0, 4294967295];
    const scratch = k.alloc(24 + 256 + nameOk.length + 8);
    const bounds = scratch;
    const rirOk = scratch + 24;
    const nameOkPtr = scratch + 24 + 256;
    k.u32(bounds, 6).set([prefix[0]!, prefix[1]!, path[0]!, path[1]!, addr[0]!, addr[1]!]);
    k.u8(rirOk, 256).set(regionOk);
    k.u8(nameOkPtr, nameOk.length).set(nameOk);
    k.mask(n, p.len, p.pathLen, p.addr, p.rir, p.name, bounds, rirOk, nameOkPtr, nameOk.length, o.mask);
    k.free(scratch, 24 + 256 + nameOk.length + 8);
    const keepAll = 0x1f;
    const g = k.cNetworks(n, o.mask, keepAll, p.origin, p.name, o.q1As, o.q1Name, o.q1Count);
    const networks = { origin_as: k.u32(o.q1As, g).slice(), name: k.u32(o.q1Name, g).slice(), n: k.u32(o.q1Count, g).slice() };
    const hist = k.alloc(256 * 4 * 4);
    k.cHist(n, o.mask, keepAll & ~1, p.len, hist);
    k.cHist(n, o.mask, keepAll & ~2, p.pathLen, hist + 1024);
    k.cRegions(n, o.mask, keepAll & ~8, p.rir, p.origin, hist + 2048, hist + 3072);
    this.check();
    const result = {
      networks,
      prefixLen: k.u32(hist, 256).slice(),
      pathLen: k.u32(hist + 1024, 256).slice(),
      regions: { routes: k.u32(hist + 2048, 256).slice(), networks: k.u32(hist + 3072, 256).slice() },
    };
    k.free(hist, 256 * 4 * 4);
    return result;
  }

  private check(): void {
    // Purpose: turn a counter overflow in the module into an error, as the JS executor does
    if (this.k.overflowed() !== 0) throw new Error('integer overflow in a counter');
  }
}

export interface DashboardSelection {
  readonly prefixLen: readonly [number, number] | null;
  readonly pathLen: readonly [number, number] | null;
  readonly regions: readonly string[] | null;
  readonly search: string;
  readonly addr: readonly [number, number] | null;
}

export interface DashboardResult {
  readonly networks: { origin_as: Uint32Array; name: Uint32Array; n: Uint32Array };
  readonly prefixLen: Uint32Array;
  readonly pathLen: Uint32Array;
  readonly regions: { routes: Uint32Array; networks: Uint32Array };
}
