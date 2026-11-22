import type { SearchCenter } from '../types';

/**
 * Adres zoeken via Photon (komoot, op basis van OpenStreetMap): gratis, CORS, geschikt voor
 * zoeken-terwijl-je-typt. Valt terug op Nominatim voor een definitieve zoekopdracht.
 */
interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: Record<string, string | undefined>;
}

export function photonLabel(p: Record<string, string | undefined>): string {
  const street = p.street ? [p.street, p.housenumber].filter(Boolean).join(' ') : undefined;
  const first = p.name && p.name !== p.street ? p.name : street;
  const parts = [first, p.name && p.name !== p.street ? street : undefined, p.postcode, p.city ?? p.town ?? p.village, p.city ? undefined : p.county, p.country !== 'Nederland' && p.country !== 'Netherlands' ? p.country : undefined];
  return [...new Set(parts.filter(Boolean))].join(', ');
}

export async function suggest(q: string, near?: { lat: number; lng: number }, signal?: AbortSignal): Promise<SearchCenter[]> {
  if (q.trim().length < 3) return [];
  const u = new URL('https://photon.komoot.io/api/');
  u.searchParams.set('q', q);
  u.searchParams.set('limit', '6');
  u.searchParams.set('lang', 'default');
  if (near) {
    u.searchParams.set('lat', String(near.lat));
    u.searchParams.set('lon', String(near.lng));
  }
  const res = await fetch(u, { signal });
  if (!res.ok) throw new Error(`Photon ${res.status}`);
  const j = (await res.json()) as { features: PhotonFeature[] };
  return j.features.map((f) => ({
    lat: f.geometry.coordinates[1],
    lng: f.geometry.coordinates[0],
    label: photonLabel(f.properties),
  }));
}

export async function geocode(q: string, signal?: AbortSignal): Promise<SearchCenter | null> {
  try {
    const s = await suggest(q, undefined, signal);
    if (s.length) return s[0];
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
  }
  const u = new URL('https://nominatim.openstreetmap.org/search');
  u.searchParams.set('q', q);
  u.searchParams.set('format', 'jsonv2');
  u.searchParams.set('limit', '1');
  u.searchParams.set('accept-language', 'nl');
  const res = await fetch(u, { signal });
  if (!res.ok) return null;
  const j = (await res.json()) as { lat: string; lon: string; display_name: string }[];
  if (!j.length) return null;
  return { lat: +j[0].lat, lng: +j[0].lon, label: j[0].display_name.split(',').slice(0, 3).join(',') };
}

export async function reverse(lat: number, lng: number): Promise<string> {
  try {
    const u = new URL('https://photon.komoot.io/reverse');
    u.searchParams.set('lat', String(lat));
    u.searchParams.set('lon', String(lng));
    const res = await fetch(u);
    const j = (await res.json()) as { features: PhotonFeature[] };
    if (j.features?.[0]) return photonLabel(j.features[0].properties);
  } catch {
    /* val terug op coördinaten */
  }
  return 'Mijn locatie';
}
