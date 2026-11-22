import { describe, expect, it, vi } from 'vitest';
import { bboxAround, distance, formatDistance, offset, splitBBox, travelMinutes } from '../src/geo';
import { combineNewScore, googleNewSignals, osmNewSignals, parseOsmDate } from '../src/newness';
import { applyFilters, enrich, levelFor, mergeSources, nameSimilarity, smaakScore } from '../src/logic';
import { cuisineFor, cuisineFromGoogleTypes } from '../src/cuisine';
import { GoogleProvider, mapGooglePlace } from '../src/providers/google';
import { mapOsmElement, OsmProvider, overpassQuery } from '../src/providers/osm';
import { demoRestaurants } from '../src/providers/demo';
import { DEFAULT_FILTERS } from '../src/store';
import type { Restaurant } from '../src/types';

const DAM = { lat: 52.3731, lng: 4.8926 };
const NOW = new Date('2026-11-22T12:00:00Z');

function r(p: Partial<Restaurant> & { id: string }): Restaurant {
  return { name: p.id, location: DAM, newSignals: [], sources: ['google'], ...p };
}

describe('geo', () => {
  it('berekent afstanden', () => {
    const centraal = { lat: 52.3791, lng: 4.9003 };
    expect(distance(DAM, centraal)).toBeGreaterThan(800);
    expect(distance(DAM, centraal)).toBeLessThan(900);
    expect(distance(DAM, DAM)).toBe(0);
  });
  it('offset en bbox kloppen met de straal', () => {
    const p = offset(DAM, 1000, 0);
    expect(distance(DAM, p)).toBeCloseTo(1000, -1);
    const b = bboxAround(DAM, 500);
    expect(distance(b.low, { lat: b.low.lat, lng: b.high.lng })).toBeCloseTo(1000, -1);
    expect(splitBBox(b, 2)).toHaveLength(4);
  });
  it('formatteert afstand en reistijd', () => {
    expect(formatDistance(234)).toBe('230 m');
    expect(formatDistance(1530)).toBe('1,5 km');
    expect(travelMinutes(1000, 'bike')).toBe(5);
    expect(travelMinutes(1000, 'walk')).toBe(16);
  });
});

describe('nieuw-detectie', () => {
  it('leest OSM-datums', () => {
    expect(parseOsmDate('2026-03')?.toISOString().slice(0, 7)).toBe('2026-03');
    expect(parseOsmDate('~2025')?.getUTCFullYear()).toBe(2025);
    expect(parseOsmDate('onzin')).toBeUndefined();
  });
  it('herkent een recente opening_date als sterk signaal', () => {
    const { signals, openedOn } = osmNewSignals({ opening_date: '2026-09-01' }, {}, NOW, 365);
    expect(signals[0].score).toBeGreaterThanOrEqual(90);
    expect(signals[0].reason).toContain('sep 2026');
    expect(openedOn).toBe('2026-09-01');
  });
  it('negeert oude zaken', () => {
    const { signals } = osmNewSignals({ start_date: '1998' }, { version: 14, timestamp: '2026-10-01T00:00:00Z' }, NOW, 365);
    expect(signals).toHaveLength(0);
  });
  it('ziet een vers toegevoegd OSM-object als signaal', () => {
    const { signals } = osmNewSignals({}, { version: 1, timestamp: '2026-08-10T00:00:00Z' }, NOW, 365);
    expect(signals[0].score).toBe(65);
  });
  it('weinig Google-reviews = waarschijnlijk nieuw', () => {
    expect(googleNewSignals(9, 4.8)[0].score).toBe(60);
    expect(googleNewSignals(2000, 4.8)).toHaveLength(0);
    expect(googleNewSignals(10, 3.1)).toHaveLength(0);
  });
  it('combineert signalen (noisy-OR)', () => {
    expect(combineNewScore([])).toBe(0);
    expect(combineNewScore([{ score: 50, reason: '' }, { score: 50, reason: '' }])).toBe(75);
  });
});

describe('samenvoegen Google + OSM', () => {
  it('matcht op naam en afstand', () => {
    expect(nameSimilarity('Restaurant De Kas', 'De Kas')).toBe(1);
    expect(nameSimilarity('Pizzeria Napoli', 'Napoli Pizzeria & Bar')).toBeGreaterThan(0.5);
    expect(nameSimilarity('Sushi Time', 'Burger Bar')).toBe(0);
  });
  it('verrijkt Google-zaken met OSM-signalen en houdt nieuwe OSM-zaken', () => {
    const g = [r({ id: 'g1', name: 'Bistro Mosterd', rating: 4.6, ratingCount: 300 })];
    const osm = [
      r({ id: 'osm:node/1', osmId: 'osm:node/1', name: 'Mosterd', location: offset(DAM, 30, 0), sources: ['osm'], website: 'https://mosterd.nl', newSignals: [{ score: 95, reason: 'Geopend in okt 2026' }] }),
      r({ id: 'osm:node/2', osmId: 'osm:node/2', name: 'Gloednieuw', location: offset(DAM, 400, 0), sources: ['osm'], newSignals: [{ score: 95, reason: 'Geopend in nov 2026' }] }),
      r({ id: 'osm:node/3', osmId: 'osm:node/3', name: 'Oud & Saai', location: offset(DAM, 500, 0), sources: ['osm'] }),
    ];
    const m = mergeSources(g, osm);
    expect(m).toHaveLength(2);
    expect(m[0].sources).toEqual(['google', 'osm']);
    expect(m[0].website).toBe('https://mosterd.nl');
    expect(combineNewScore(m[0].newSignals)).toBeGreaterThanOrEqual(90);
    expect(m[1].name).toBe('Gloednieuw');
  });
});

describe('filters en sortering', () => {
  const list = enrich(
    [
      r({ id: 'top', rating: 4.8, ratingCount: 900, location: offset(DAM, 300, 0), priceLevel: 2, cuisine: 'Italiaans' }),
      r({ id: 'ok', rating: 4.1, ratingCount: 500, location: offset(DAM, 200, 0), priceLevel: 1 }),
      r({ id: 'nieuw', rating: 4.3, ratingCount: 12, location: offset(DAM, 600, 0), newSignals: googleNewSignals(12, 4.3) }),
      r({ id: 'ver', rating: 4.9, ratingCount: 400, location: offset(DAM, 4000, 0) }),
    ],
    DAM,
    4.5,
  );
  it('modus "leuk" = top óf nieuw, binnen straal', () => {
    const res = applyFilters(list, { ...DEFAULT_FILTERS, radius: 1500 }, {}, true);
    expect(res.map((x) => x.id).sort()).toEqual(['nieuw', 'top']);
  });
  it('modus top/nieuw/alles', () => {
    expect(applyFilters(list, { ...DEFAULT_FILTERS, show: 'top' }, {}, true).map((x) => x.id)).toEqual(['top']);
    expect(applyFilters(list, { ...DEFAULT_FILTERS, show: 'nieuw' }, {}, true).map((x) => x.id)).toEqual(['nieuw']);
    expect(applyFilters(list, { ...DEFAULT_FILTERS, show: 'alles', radius: 5000, sort: 'distance' }, {}, true).map((x) => x.id)).toEqual(['ok', 'top', 'nieuw', 'ver']);
  });
  it('verbergt bezochte zaken en filtert op prijs', () => {
    const visits = { top: { id: 'top', name: 'top', location: DAM, visited: true, updatedAt: 1 } };
    expect(applyFilters(list, { ...DEFAULT_FILTERS, hideVisited: true }, visits, true).map((x) => x.id)).toEqual(['nieuw']);
    expect(applyFilters(list, { ...DEFAULT_FILTERS, show: 'alles', prices: [1] }, {}, true).map((x) => x.id)).toEqual(['ok']);
  });
  it('smaakscore weegt het aantal reviews mee', () => {
    expect(smaakScore(4.9, 8)).toBeLessThan(smaakScore(4.7, 900));
  });
  it('levels', () => {
    expect(levelFor(0).name).toBe('Nieuwsgierige proever');
    expect(levelFor(10).name).toBe('Fijnproever');
    expect(levelFor(99).next).toBeUndefined();
  });
});

describe('keukens', () => {
  it('vertaalt Google- en OSM-types', () => {
    expect(cuisineFor('italian;pizza').label).toBe('Italiaans');
    expect(cuisineFromGoogleTypes('restaurant', ['sushi_restaurant', 'restaurant']).label).toBe('Sushi');
    expect(cuisineFromGoogleTypes('ramen_restaurant').emoji).toBe('🍜');
  });
});

describe('Google provider', () => {
  it('zet een Places-resultaat om', () => {
    const x = mapGooglePlace(
      {
        id: 'abc',
        displayName: { text: 'Trattoria Test' },
        location: { latitude: 52.37, longitude: 4.89 },
        rating: 4.7,
        userRatingCount: 321,
        priceLevel: 'PRICE_LEVEL_MODERATE',
        primaryType: 'italian_restaurant',
        businessStatus: 'OPERATIONAL',
        photos: [{ name: 'places/abc/photos/p1' }],
      },
      'KEY',
    )!;
    expect(x.priceLevel).toBe(2);
    expect(x.cuisine).toBe('Italiaans');
    expect(x.photoUrl).toContain('places/abc/photos/p1/media');
    expect(mapGooglePlace({ id: 'z', displayName: { text: 'Dicht' }, location: { latitude: 1, longitude: 1 }, businessStatus: 'CLOSED_PERMANENTLY' }, 'K')).toBeNull();
  });
  it('pagineert, ontdubbelt en stuurt de juiste headers', async () => {
    const calls: { url: string; body: any; headers: any }[] = [];
    const fake = vi.fn(async (url: any, init: any) => {
      const body = JSON.parse(init.body);
      calls.push({ url: String(url), body, headers: init.headers });
      const place = (id: string) => ({ id, displayName: { text: id }, location: { latitude: 52.37, longitude: 4.89 }, rating: 4.6, userRatingCount: 50 });
      let json: any;
      if (String(url).endsWith('searchNearby')) json = { places: [place('a'), place('n1')] };
      else if (!body.pageToken) json = { places: [place('a'), place('b')], nextPageToken: 'T2' };
      else json = { places: [place('c')] };
      return new Response(JSON.stringify(json), { status: 200 });
    });
    const g = new GoogleProvider('KEY', fake as any);
    const res = await g.search(DAM, 1000, 4.5);
    expect(res.map((x) => x.id).sort()).toEqual(['a', 'b', 'c', 'n1']);
    expect(g.calls).toBe(3);
    const text = calls.find((c) => c.url.endsWith('searchText'))!;
    expect(text.body.minRating).toBe(4.5);
    expect(text.headers['X-Goog-Api-Key']).toBe('KEY');
    expect(text.headers['X-Goog-FieldMask']).toContain('places.rating');
    expect(text.headers['X-Goog-FieldMask']).toContain('nextPageToken');
  });
  it('geeft een nette fout bij een ongeldige sleutel', async () => {
    const fake = async () => new Response(JSON.stringify({ error: { message: 'API key not valid' } }), { status: 400 });
    await expect(new GoogleProvider('X', fake as any).search(DAM, 500, 4.5)).rejects.toThrow('API key not valid');
  });
});

describe('OSM provider', () => {
  it('bouwt een Overpass-query', () => {
    expect(overpassQuery(DAM, 1500)).toContain('(around:1500,52.373100,4.892600)');
  });
  it('zet elementen om en valt terug op een tweede server', async () => {
    let n = 0;
    const fake = async () => {
      n++;
      if (n === 1) return new Response('busy', { status: 429 });
      return new Response(
        JSON.stringify({
          elements: [
            { type: 'node', id: 1, lat: 52.37, lon: 4.89, version: 1, timestamp: '2026-10-01T00:00:00Z', tags: { name: 'Vers', cuisine: 'thai', website: 'vers.nl' } },
            { type: 'way', id: 2, center: { lat: 52.38, lon: 4.9 }, tags: { amenity: 'restaurant' } },
          ],
        }),
      );
    };
    const res = await new OsmProvider(365, fake as any, () => NOW).search(DAM, 1000);
    expect(res).toHaveLength(1);
    expect(res[0].cuisine).toBe('Thais');
    expect(res[0].website).toBe('https://vers.nl');
    expect(res[0].newSignals[0].reason).toContain('okt 2026');
  });
  it('mapOsmElement gebruikt center van ways', () => {
    const x = mapOsmElement({ type: 'way', id: 5, center: { lat: 1, lon: 2 }, tags: { name: 'W' } }, NOW, 365)!;
    expect(x.location).toEqual({ lat: 1, lng: 2 });
  });
});

describe('demo', () => {
  it('is deterministisch en binnen de straal', () => {
    const a = demoRestaurants(DAM, 1500, NOW);
    const b = demoRestaurants(DAM, 1500, NOW);
    expect(a.map((x) => x.name)).toEqual(b.map((x) => x.name));
    expect(a.every((x) => distance(DAM, x.location) <= 1501)).toBe(true);
    expect(a.some((x) => (x.rating ?? 0) >= 4.5)).toBe(true);
  });
});
