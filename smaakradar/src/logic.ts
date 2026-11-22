import type { EnrichedRestaurant, Filters, LatLng, Restaurant, VisitRecord } from './types';
import { distance } from './geo';
import { combineNewScore, NEW_THRESHOLD } from './newness';

/** "Café-Restaurant De Gouden Lepel B.V." → "gouden lepel" */
export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' en ')
    .replace(/\b(restaurant|ristorante|cafe|eetcafe|bistro|brasserie|grand cafe|de|het|the|la|le|il|b\.?v\.?)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function nameSimilarity(a: string, b: string): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return a.toLowerCase() === b.toLowerCase() ? 1 : 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.85;
  const ta = new Set(na.split(' '));
  const tb = new Set(nb.split(' '));
  const inter = [...ta].filter((t) => tb.has(t)).length;
  const jaccard = inter / new Set([...ta, ...tb]).size;
  // Overlap: "Napoli Pizzeria" ⊂ "Napoli Pizzeria & Bar"
  const overlap = inter / Math.min(ta.size, tb.size);
  return Math.max(jaccard, overlap * 0.8);
}

/**
 * Voeg OSM-resultaten samen met Google-resultaten. Google is leidend (ratings, foto's);
 * OSM levert extra "nieuw"-signalen, keuken en website. OSM-zaken zonder Google-match
 * blijven alleen over als ze nieuw lijken (precies de zaken die Google nog mist).
 */
export function mergeSources(google: Restaurant[], osm: Restaurant[]): Restaurant[] {
  const out = google.map((g) => ({ ...g, newSignals: [...g.newSignals], sources: [...g.sources] }));
  for (const o of osm) {
    let best: Restaurant | undefined;
    let bestScore = 0;
    for (const g of out) {
      const d = distance(o.location, g.location);
      if (d > 120) continue;
      const sim = nameSimilarity(o.name, g.name);
      const score = sim - d / 600;
      if (sim >= 0.5 && score > bestScore) {
        best = g;
        bestScore = score;
      }
    }
    if (best) {
      best.osmId = o.osmId;
      if (!best.sources.includes('osm')) best.sources.push('osm');
      best.newSignals.push(...o.newSignals);
      best.openedOn ??= o.openedOn;
      best.website ??= o.website;
      best.phone ??= o.phone;
      if ((!best.cuisine || best.cuisine === 'Restaurant') && o.cuisine && o.cuisine !== 'Restaurant') {
        best.cuisine = o.cuisine;
        best.cuisineEmoji = o.cuisineEmoji;
      }
    } else if (combineNewScore(o.newSignals) >= NEW_THRESHOLD) {
      out.push({ ...o, newSignals: [...o.newSignals, { score: 30, reason: 'Nog niet gevonden op Google' }] });
    }
  }
  return out;
}

/** Bayesiaans gemiddelde: 4,9 met 8 reviews is minder zeker dan 4,7 met 900 reviews. */
export function smaakScore(rating?: number, count = 0, prior = 4.2, weight = 40): number {
  if (rating === undefined) return 0;
  return (rating * count + prior * weight) / (count + weight);
}

export function enrich(list: Restaurant[], center: LatLng, minRating: number): EnrichedRestaurant[] {
  return list.map((r) => {
    const newScore = combineNewScore(r.newSignals);
    return {
      ...r,
      distance: distance(center, r.location),
      newScore,
      isNew: newScore >= NEW_THRESHOLD,
      isTop: r.rating !== undefined && r.rating >= minRating,
      smaakScore: smaakScore(r.rating, r.ratingCount),
    };
  });
}

export function applyFilters(
  list: EnrichedRestaurant[],
  f: Filters,
  visits: Record<string, VisitRecord>,
  hasRatings: boolean,
): EnrichedRestaurant[] {
  const q = f.query.trim().toLowerCase();
  const res = list.filter((r) => {
    if (r.distance > f.radius) return false;
    const v = visits[r.id];
    // Zonder ratings (OSM-modus) betekent "top" niets; dan tonen we alles bij 'leuk'.
    const top = hasRatings ? r.rating !== undefined && r.rating >= f.minRating : true;
    if (f.show === 'top' && !top) return false;
    if (f.show === 'nieuw' && !r.isNew) return false;
    if (f.show === 'leuk' && !(top || r.isNew)) return false;
    if (f.openNow && r.openNow === false) return false;
    if (f.hideVisited && v?.visited) return false;
    if (f.onlyWishlist && !v?.wishlist) return false;
    if (f.prices.length && (r.priceLevel === undefined || !f.prices.includes(r.priceLevel))) return false;
    if (f.cuisine && r.cuisine !== f.cuisine) return false;
    if (q && !`${r.name} ${r.cuisine ?? ''} ${r.address ?? ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
  return sortList(res, f.sort);
}

export function sortList(list: EnrichedRestaurant[], sort: Filters['sort']): EnrichedRestaurant[] {
  const by: Record<Filters['sort'], (a: EnrichedRestaurant, b: EnrichedRestaurant) => number> = {
    // "Beste match": smaakscore, licht gecorrigeerd voor afstand, met een bonus voor nieuw
    match: (a, b) => matchScore(b) - matchScore(a),
    rating: (a, b) => (b.rating ?? 0) - (a.rating ?? 0) || (b.ratingCount ?? 0) - (a.ratingCount ?? 0),
    distance: (a, b) => a.distance - b.distance,
    reviews: (a, b) => (b.ratingCount ?? 0) - (a.ratingCount ?? 0),
    new: (a, b) => b.newScore - a.newScore || (b.openedOn ?? '').localeCompare(a.openedOn ?? '') || a.distance - b.distance,
  };
  return [...list].sort(by[sort]);
}

export function matchScore(r: EnrichedRestaurant): number {
  const base = r.rating !== undefined ? r.smaakScore : 4.0;
  return base + (r.isNew ? 0.25 : 0) - r.distance / 8000;
}

export function cuisineCounts(list: EnrichedRestaurant[]): [string, string, number][] {
  const m = new Map<string, [string, number]>();
  for (const r of list) {
    if (!r.cuisine || r.cuisine === 'Restaurant') continue;
    const cur = m.get(r.cuisine);
    m.set(r.cuisine, [r.cuisineEmoji ?? '🍽️', (cur?.[1] ?? 0) + 1]);
  }
  return [...m.entries()].map(([k, [e, n]]) => [k, e, n] as [string, string, number]).sort((a, b) => b[2] - a[2]);
}

export interface Level {
  name: string;
  emoji: string;
  min: number;
  next?: number;
}

const LEVELS: Omit<Level, 'next'>[] = [
  { name: 'Nieuwsgierige proever', emoji: '🥄', min: 0 },
  { name: 'Lekkerbek', emoji: '😋', min: 3 },
  { name: 'Fijnproever', emoji: '🍷', min: 10 },
  { name: 'Culinair ontdekker', emoji: '🧭', min: 25 },
  { name: 'Smaakradar-legende', emoji: '👑', min: 50 },
];

export function levelFor(visited: number): Level {
  let i = 0;
  while (i + 1 < LEVELS.length && visited >= LEVELS[i + 1].min) i++;
  return { ...LEVELS[i], next: LEVELS[i + 1]?.min };
}
