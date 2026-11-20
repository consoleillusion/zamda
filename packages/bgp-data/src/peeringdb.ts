// Parses the two public PeeringDB bulk endpoints used by `prep-bgp`:
//   /api/fac    facility id, latitude, longitude and status
//   /api/netfac AS number, facility id and status
// An AS is placed at the circular mean of its distinct, open facilities. That is
// a self-reported peering footprint, not a router or user location; ASes without
// a usable facility keep the country-centre fallback in `graph-file.ts`.

export interface GeoPoint {
  readonly lat: number;
  readonly lon: number;
}

export interface PeeringLocation extends GeoPoint {
  readonly facilities: number;
}

interface ApiRecord {
  readonly [key: string]: unknown;
}

function apiRecords(text: string): readonly ApiRecord[] {
  // Purpose: the `data` array from one PeeringDB API response, with bad entries skipped
  const parsed = JSON.parse(text) as { data?: unknown };
  if (!Array.isArray(parsed.data)) throw new Error('PeeringDB response has no data array');
  return parsed.data.filter(function (value): value is ApiRecord {
    // Purpose: keep only object records
    return typeof value === 'object' && value !== null;
  });
}

function finiteNumber(value: unknown): number | null {
  // Purpose: a finite number field, or null when PeeringDB sent something else
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asnField(value: unknown): number | null {
  // Purpose: a valid 32-bit AS number from a netfac record
  const asn = finiteNumber(value);
  return asn !== null && Number.isInteger(asn) && asn > 0 && asn <= 4294967295 ? asn : null;
}

function isOpen(record: ApiRecord): boolean {
  // Purpose: only active records contribute a point
  return record.status === 'ok' || record.status === undefined;
}

export function parseFacilities(text: string): Map<number, GeoPoint> {
  // Purpose: facility id to geographic point, rejecting closed or badly placed facilities
  const facilities = new Map<number, GeoPoint>();
  for (const record of apiRecords(text)) {
    if (!isOpen(record)) continue;
    const id = finiteNumber(record.id);
    const lat = finiteNumber(record.latitude);
    const lon = finiteNumber(record.longitude);
    if (
      id === null || !Number.isInteger(id) || id <= 0 ||
      lat === null || lat < -90 || lat > 90 ||
      lon === null || lon < -180 || lon > 180
    ) continue;
    facilities.set(id, { lat, lon });
  }
  return facilities;
}

export function parseNetFacilities(
  text: string,
  facilities: ReadonlyMap<number, GeoPoint>,
): Map<number, PeeringLocation> {
  // Purpose: one circular-mean point per ASN from its distinct facility memberships
  const memberships = new Map<number, { readonly ids: Set<number>; readonly points: GeoPoint[] }>();
  for (const record of apiRecords(text)) {
    if (!isOpen(record)) continue;
    const asn = asnField(record.local_asn);
    const facilityId = finiteNumber(record.fac_id);
    if (asn === null || facilityId === null || !Number.isInteger(facilityId)) continue;
    const point = facilities.get(facilityId);
    if (!point) continue;
    let group = memberships.get(asn);
    if (!group) {
      group = { ids: new Set<number>(), points: [] };
      memberships.set(asn, group);
    }
    if (group.ids.has(facilityId)) continue;
    group.ids.add(facilityId);
    group.points.push(point);
  }
  const locations = new Map<number, PeeringLocation>();
  const toRad = Math.PI / 180;
  for (const [asn, group] of memberships) {
    // Purpose: average directions on the sphere so facilities across the dateline stay together
    let x = 0;
    let y = 0;
    let z = 0;
    for (const point of group.points) {
      const lat = point.lat * toRad;
      const lon = point.lon * toRad;
      x += Math.cos(lat) * Math.cos(lon);
      y += Math.cos(lat) * Math.sin(lon);
      z += Math.sin(lat);
    }
    const flat = Math.hypot(x, y);
    const lat = Math.atan2(z, flat) / toRad;
    const lon = flat < 1e-12 ? 0 : Math.atan2(y, x) / toRad;
    locations.set(asn, { lat, lon, facilities: group.points.length });
  }
  return locations;
}
