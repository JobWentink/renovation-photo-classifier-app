import type { LatLng } from './types';

const R = 6371008.8; // gemiddelde aardstraal in meters
const toRad = (d: number) => (d * Math.PI) / 180;

/** Afstand in meters tussen twee punten (haversine). */
export function distance(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Verschuif een punt een aantal meters naar noord (dy) en oost (dx). */
export function offset(p: LatLng, dx: number, dy: number): LatLng {
  const lat = p.lat + (dy / R) * (180 / Math.PI);
  const lng = p.lng + ((dx / R) * (180 / Math.PI)) / Math.cos(toRad(p.lat));
  return { lat, lng };
}

export interface BBox {
  low: LatLng; // zuidwest
  high: LatLng; // noordoost
}

/** Rechthoek die een cirkel met straal r omsluit. */
export function bboxAround(c: LatLng, r: number): BBox {
  const sw = offset(c, -r, -r);
  const ne = offset(c, r, r);
  return { low: sw, high: ne };
}

/** Splits een bbox in n×n tegels (voor meer dekking bij grote straal). */
export function splitBBox(b: BBox, n: number): BBox[] {
  const out: BBox[] = [];
  const dLat = (b.high.lat - b.low.lat) / n;
  const dLng = (b.high.lng - b.low.lng) / n;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      out.push({
        low: { lat: b.low.lat + i * dLat, lng: b.low.lng + j * dLng },
        high: { lat: b.low.lat + (i + 1) * dLat, lng: b.low.lng + (j + 1) * dLng },
      });
    }
  }
  return out;
}

export function formatDistance(m: number): string {
  if (m < 950) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(m < 9950 ? 1 : 0).replace('.', ',')} km`;
}

/** Reistijd in minuten. Fietsen ~15 km/u, lopen ~5 km/u; ×1.3 omdat straten niet hemelsbreed lopen. */
export function travelMinutes(m: number, mode: 'walk' | 'bike'): number {
  const speed = mode === 'walk' ? 5000 / 60 : 15000 / 60; // meter per minuut
  return Math.max(1, Math.round((m * 1.3) / speed));
}
