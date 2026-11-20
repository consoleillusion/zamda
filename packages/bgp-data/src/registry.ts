// Parsers for the registry files that label each network:
//   - asn.txt from RIPE (https://ftp.ripe.net/ripe/asnames/asn.txt): one line per
//     AS, "<asn> <name>, <country>". The country is kept for graph layout.
//   - NRO delegated statistics: pipe-separated records
//     "registry|cc|type|start|value|date|status|...". Records of type "asn" give a
//     range of AS numbers (start, count) and the registry that delegated them.
//   - mledoze/countries: JSON country records with `cca2` and `latlng`, used as
//     approximate centres for the graph's country groups.

export const RIR_NAMES: Readonly<Record<string, string>> = {
  afrinic: 'AFRINIC',
  apnic: 'APNIC',
  arin: 'ARIN',
  lacnic: 'LACNIC',
  ripencc: 'RIPE NCC',
};

function asnLine(raw: string): { asn: number; label: string } | null {
  // Purpose: the AS number and trailing label from one asn.txt line
  const line = raw.trim();
  const space = line.indexOf(' ');
  if (space <= 0) return null;
  const asn = Number(line.slice(0, space));
  if (!Number.isInteger(asn) || asn < 0 || asn > 4294967295) return null;
  const label = line.slice(space + 1).trim();
  return label ? { asn, label } : null;
}

function trailingCountry(label: string): string | null {
  // Purpose: the ISO-2 country at the end of an asn.txt label, if present
  const comma = label.lastIndexOf(', ');
  if (comma === -1) return null;
  const country = label.slice(comma + 2);
  return /^[A-Z]{2}$/.test(country) ? country : null;
}

export function parseAsNames(text: string): Map<number, string> {
  // Purpose: AS number to name; the trailing ", <country>" is removed
  const names = new Map<number, string>();
  for (const raw of text.split('\n')) {
    const parsed = asnLine(raw);
    if (!parsed) continue;
    const country = trailingCountry(parsed.label);
    const name = country === null ? parsed.label : parsed.label.slice(0, parsed.label.lastIndexOf(', '));
    if (name) names.set(parsed.asn, name);
  }
  return names;
}

export function parseAsCountries(text: string): Map<number, string> {
  // Purpose: AS number to the country registered beside its name in asn.txt
  const countries = new Map<number, string>();
  for (const raw of text.split('\n')) {
    const parsed = asnLine(raw);
    if (!parsed) continue;
    const country = trailingCountry(parsed.label);
    if (country !== null) countries.set(parsed.asn, country);
  }
  return countries;
}

export interface CountryCentre {
  readonly lat: number;
  readonly lon: number;
}

export function parseCountryCentres(text: string): Map<string, CountryCentre> {
  // Purpose: ISO-2 country to one approximate point from the mledoze dataset
  const records = JSON.parse(text) as unknown;
  const centres = new Map<string, CountryCentre>();
  if (!Array.isArray(records)) throw new Error('Country centres must be a JSON array');
  for (const record of records) {
    if (typeof record !== 'object' || record === null) continue;
    const fields = record as { cca2?: unknown; latlng?: unknown };
    if (typeof fields.cca2 !== 'string' || !/^[A-Z]{2}$/.test(fields.cca2)) continue;
    const point = fields.latlng;
    if (!Array.isArray(point) || point.length !== 2) continue;
    const [lat, lon] = point;
    if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    centres.set(fields.cca2, { lat, lon });
  }
  return centres;
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
