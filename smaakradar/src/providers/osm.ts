import type { LatLng, Restaurant } from '../types';
import { cuisineFor } from '../cuisine';
import { osmNewSignals } from '../newness';

/** Overpass API (OpenStreetMap). Gratis, geen sleutel nodig, geen ratings. */
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

export interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
  version?: number;
  timestamp?: string;
}

export function overpassQuery(c: LatLng, radius: number): string {
  const r = Math.round(radius);
  const around = `(around:${r},${c.lat.toFixed(6)},${c.lng.toFixed(6)})`;
  return `[out:json][timeout:25];(nwr["amenity"="restaurant"]${around};);out center meta;`;
}

function address(t: Record<string, string>): string | undefined {
  const street = [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(' ');
  const city = t['addr:city'];
  const s = [street, city].filter(Boolean).join(', ');
  return s || undefined;
}

export function mapOsmElement(e: OsmElement, now: Date, windowDays: number): Restaurant | null {
  const t = e.tags ?? {};
  const lat = e.lat ?? e.center?.lat;
  const lng = e.lon ?? e.center?.lon;
  if (lat === undefined || lng === undefined || !t.name) return null;
  const cuisine = cuisineFor(t.cuisine);
  const { signals, openedOn } = osmNewSignals(t, { version: e.version, timestamp: e.timestamp }, now, windowDays);
  const id = `osm:${e.type}/${e.id}`;
  let website = t.website ?? t['contact:website'];
  if (website && !/^https?:\/\//.test(website)) website = `https://${website}`;
  return {
    id,
    osmId: id,
    name: t.name,
    location: { lat, lng },
    address: address(t),
    cuisine: cuisine.label,
    cuisineEmoji: cuisine.emoji,
    openingHours: t.opening_hours ? [t.opening_hours] : undefined,
    website,
    phone: t.phone ?? t['contact:phone'],
    openedOn,
    newSignals: signals,
    sources: ['osm'],
  };
}

type Fetch = typeof fetch;

export class OsmProvider {
  calls = 0;
  constructor(
    private windowDays: number,
    private fetchImpl: Fetch = (...a) => fetch(...a),
    private now: () => Date = () => new Date(),
  ) {}

  async search(center: LatLng, radius: number, signal?: AbortSignal): Promise<Restaurant[]> {
    const q = overpassQuery(center, radius);
    let lastErr: unknown;
    for (const url of ENDPOINTS) {
      try {
        this.calls++;
        const res = await this.fetchImpl(url, {
          method: 'POST',
          body: new URLSearchParams({ data: q }),
          signal,
        });
        if (!res.ok) throw new Error(`Overpass ${res.status}`);
        const json = (await res.json()) as { elements: OsmElement[] };
        const now = this.now();
        return json.elements
          .map((e) => mapOsmElement(e, now, this.windowDays))
          .filter((r): r is Restaurant => r !== null);
      } catch (err) {
        if ((err as Error).name === 'AbortError') throw err;
        lastErr = err;
      }
    }
    throw new Error(`OpenStreetMap is even niet bereikbaar (${(lastErr as Error)?.message ?? 'onbekend'})`);
  }
}
