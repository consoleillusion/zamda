// Parsers for the two registry files that label each network:
//   - asn.txt from RIPE (https://ftp.ripe.net/ripe/asnames/asn.txt): one line per
//     AS, "<asn> <name>, <country>".
//   - NRO delegated statistics: pipe-separated records
//     "registry|cc|type|start|value|date|status|...". Records of type "asn" give a
//     range of AS numbers (start, count) and the registry that delegated them.

export const RIR_NAMES: Readonly<Record<string, string>> = {
  afrinic: 'AFRINIC',
  apnic: 'APNIC',
  arin: 'ARIN',
  lacnic: 'LACNIC',
  ripencc: 'RIPE NCC',
};

export function parseAsNames(text: string): Map<number, string> {
  // Purpose: AS number to name; the trailing ", <country>" is removed
  const names = new Map<number, string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const space = line.indexOf(' ');
    if (space <= 0) continue;
    const asn = Number(line.slice(0, space));
    if (!Number.isInteger(asn) || asn < 0 || asn > 4294967295) continue;
    let name = line.slice(space + 1).trim();
    const comma = name.lastIndexOf(', ');
    if (comma !== -1 && /^[A-Z]{2}$/.test(name.slice(comma + 2))) name = name.slice(0, comma);
    if (name) names.set(asn, name);
  }
  return names;
}

export interface AsnRange {
  readonly start: number;
  readonly end: number; // inclusive
  readonly rir: string;
}

export function parseRirRanges(text: string): AsnRange[] {
  // Purpose: the AS number ranges each RIR delegated, sorted by start; IANA and unknown registries are skipped
  const ranges: AsnRange[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) continue;
    const fields = line.split('|');
    if (fields.length < 7 || fields[2] !== 'asn') continue;
    const rir = RIR_NAMES[fields[0]!];
    const start = Number(fields[3]);
    const count = Number(fields[4]);
    // Summary lines have "*" in the start field and fail this check.
    if (!rir || !Number.isInteger(start) || !Number.isInteger(count) || count < 1) continue;
    ranges.push({ start, end: start + count - 1, rir });
  }
  return ranges.sort(function (a, b) {
    return a.start - b.start;
  });
}

export function rirLookup(ranges: readonly AsnRange[]): (asn: number) => string | null {
  // Purpose: a function from AS number to RIR name, by binary search over sorted ranges
  return function (asn) {
    // Purpose: find the range containing `asn`, if any
    let lo = 0;
    let hi = ranges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const range = ranges[mid]!;
      if (asn < range.start) hi = mid - 1;
      else if (asn > range.end) lo = mid + 1;
      else return range.rir;
    }
    return null;
  };
}
