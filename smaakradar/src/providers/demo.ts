import type { LatLng, Restaurant } from '../types';
import { offset } from '../geo';
import { cuisineFor } from '../cuisine';
import { googleNewSignals, monthLabel } from '../newness';

/**
 * Demo-modus: verzonnen restaurants rond het gekozen adres, zodat je de app kunt uitproberen
 * zonder API-sleutel. Alles is fictief en wordt in de app duidelijk als demo gemarkeerd.
 */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

const PREFIX = ['Bistro', 'Trattoria', 'Eethuis', 'Brasserie', 'Kantine', 'Keuken', 'Atelier', 'Proeflokaal', 'Izakaya', 'Osteria', 'Cantina', 'Bar'];
const NOUN = ['Lepel', 'Vork', 'Kers', 'Haring', 'Vijg', 'Olijf', 'Mosterd', 'Peper', 'Tijm', 'Dadel', 'Walnoot', 'Rabarber', 'Saffraan', 'Kombu', 'Yuzu', 'Venkel', 'Kaneel', 'Zeekraal', 'Koriander', 'Truffel'];
const ADJ = ['Gouden', 'Blauwe', 'Wilde', 'Vrolijke', 'Stille', 'Hongerige', 'Gulle', 'Rode', 'Groene', 'Dronken'];
const CUISINES = ['italian', 'japanese', 'french', 'thai', 'indonesian', 'vegan', 'seafood', 'mexican', 'lebanese', 'dutch', 'korean', 'pizza', 'burger', 'indian', 'spanish', 'vietnamese', 'greek', 'surinamese', 'fine_dining', 'brunch'];
const STREETS = ['Lindengracht', 'Kerkstraat', 'Molenweg', 'Havenkade', 'Bloemstraat', 'Stationsplein', 'Marktstraat', 'Dijkweg', 'Oranjestraat', 'Brouwersgracht'];

export function demoRestaurants(center: LatLng, radius: number, now = new Date()): Restaurant[] {
  const seed = Math.round(center.lat * 1000) * 7919 + Math.round(center.lng * 1000);
  const rand = rng(seed);
  const n = Math.round(35 + Math.min(radius, 5000) / 60);
  const out: Restaurant[] = [];
  for (let i = 0; i < n; i++) {
    const ang = rand() * Math.PI * 2;
    const dist = Math.sqrt(rand()) * radius;
    const loc = offset(center, Math.cos(ang) * dist, Math.sin(ang) * dist);
    const pre = PREFIX[Math.floor(rand() * PREFIX.length)];
    const name = rand() < 0.5
      ? `${pre} ${NOUN[Math.floor(rand() * NOUN.length)]}`
      : `De ${ADJ[Math.floor(rand() * ADJ.length)]} ${NOUN[Math.floor(rand() * NOUN.length)]}`;
    const c = cuisineFor(CUISINES[Math.floor(rand() * CUISINES.length)]);
    const isNew = rand() < 0.14;
    const count = isNew ? Math.floor(rand() * 35) : Math.floor(40 + rand() ** 2 * 2400);
    const rating = Math.round(Math.min(5, Math.max(3.4, 4.25 + (rand() - 0.45) * 1.3 + (isNew ? 0.2 : 0))) * 10) / 10;
    const signals = googleNewSignals(count, rating);
    let openedOn: string | undefined;
    if (isNew && rand() < 0.7) {
      const d = new Date(now.getTime() - Math.floor(rand() * 200) * 86400000);
      openedOn = d.toISOString().slice(0, 10);
      signals.push({ score: 95, reason: `Geopend in ${monthLabel(d)}` });
    }
    const street = STREETS[Math.floor(rand() * STREETS.length)];
    const hue = Math.floor(rand() * 360);
    out.push({
      id: `demo:${seed}:${i}`,
      name,
      location: loc,
      address: `${street} ${1 + Math.floor(rand() * 180)} (demo)`,
      rating: count === 0 ? undefined : rating,
      ratingCount: count,
      priceLevel: 1 + Math.floor(rand() * 4),
      cuisine: c.label,
      cuisineEmoji: c.emoji,
      openNow: rand() < 0.65,
      openingHours: ['ma: gesloten', 'di–zo: 17:00–23:00'],
      openedOn,
      photoUrl: `demo-hue:${hue}`,
      newSignals: signals,
      sources: ['demo'],
    });
  }
  return out;
}
