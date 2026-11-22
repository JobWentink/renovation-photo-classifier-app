import type { LatLng, Restaurant } from '../types';
import { bboxAround, splitBBox, type BBox } from '../geo';
import { cuisineFromGoogleTypes } from '../cuisine';
import { googleNewSignals } from '../newness';

/**
 * Google Places API (New): https://developers.google.com/maps/documentation/places/web-service
 * Deze API ondersteunt CORS, dus hij werkt direct vanuit de browser met een sleutel die je
 * beperkt tot jouw domein (HTTP-referrer).
 */
const BASE = 'https://places.googleapis.com/v1';

const FIELDS = [
  'id',
  'displayName',
  'formattedAddress',
  'shortFormattedAddress',
  'location',
  'rating',
  'userRatingCount',
  'priceLevel',
  'primaryType',
  'types',
  'businessStatus',
  'googleMapsUri',
  'websiteUri',
  'nationalPhoneNumber',
  'currentOpeningHours.openNow',
  'regularOpeningHours.weekdayDescriptions',
  'photos',
];

const PRICE: Record<string, number> = {
  PRICE_LEVEL_FREE: 1,
  PRICE_LEVEL_INEXPENSIVE: 1,
  PRICE_LEVEL_MODERATE: 2,
  PRICE_LEVEL_EXPENSIVE: 3,
  PRICE_LEVEL_VERY_EXPENSIVE: 4,
};

export interface GooglePlace {
  id: string;
  displayName?: { text: string };
  formattedAddress?: string;
  shortFormattedAddress?: string;
  location?: { latitude: number; longitude: number };
  rating?: number;
  userRatingCount?: number;
  priceLevel?: string;
  primaryType?: string;
  types?: string[];
  businessStatus?: string;
  googleMapsUri?: string;
  websiteUri?: string;
  nationalPhoneNumber?: string;
  currentOpeningHours?: { openNow?: boolean };
  regularOpeningHours?: { weekdayDescriptions?: string[] };
  photos?: { name: string }[];
}

export class GoogleApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export function photoUrl(photoName: string, key: string, width = 640): string {
  return `${BASE}/${photoName}/media?maxWidthPx=${width}&key=${encodeURIComponent(key)}`;
}

export function mapGooglePlace(p: GooglePlace, key: string): Restaurant | null {
  if (!p.location || !p.displayName?.text) return null;
  if (p.businessStatus && p.businessStatus !== 'OPERATIONAL') return null;
  const cuisine = cuisineFromGoogleTypes(p.primaryType, p.types);
  return {
    id: p.id,
    googleId: p.id,
    name: p.displayName.text,
    location: { lat: p.location.latitude, lng: p.location.longitude },
    address: p.shortFormattedAddress ?? p.formattedAddress,
    rating: p.rating,
    ratingCount: p.userRatingCount ?? 0,
    priceLevel: p.priceLevel ? PRICE[p.priceLevel] : undefined,
    cuisine: cuisine.label,
    cuisineEmoji: cuisine.emoji,
    openNow: p.currentOpeningHours?.openNow,
    openingHours: p.regularOpeningHours?.weekdayDescriptions,
    website: p.websiteUri,
    phone: p.nationalPhoneNumber,
    mapsUrl: p.googleMapsUri,
    photoUrl: p.photos?.[0] ? photoUrl(p.photos[0].name, key) : undefined,
    newSignals: googleNewSignals(p.userRatingCount, p.rating),
    sources: ['google'],
  };
}

type Fetch = typeof fetch;

export class GoogleProvider {
  calls = 0;
  constructor(
    private key: string,
    private fetchImpl: Fetch = (...a) => fetch(...a),
  ) {}

  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<{ places?: GooglePlace[]; nextPageToken?: string }> {
    this.calls++;
    const res = await this.fetchImpl(`${BASE}/${path}`, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': this.key,
        'X-Goog-FieldMask': FIELDS.map((f) => `places.${f}`).join(',') + ',nextPageToken',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let msg = `Google Places gaf foutcode ${res.status}`;
      try {
        const j = await res.json();
        if (j?.error?.message) msg = j.error.message;
      } catch {
        /* negeer */
      }
      throw new GoogleApiError(msg, res.status);
    }
    return res.json();
  }

  /** Text Search met minRating; tot 3 pagina's (60 resultaten) per gebied. */
  private async topRated(box: BBox, minRating: number, signal?: AbortSignal, maxPages = 3): Promise<GooglePlace[]> {
    const out: GooglePlace[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const body: Record<string, unknown> = {
        textQuery: 'restaurant',
        includedType: 'restaurant',
        strictTypeFiltering: false,
        minRating,
        pageSize: 20,
        languageCode: 'nl',
        locationRestriction: {
          rectangle: {
            low: { latitude: box.low.lat, longitude: box.low.lng },
            high: { latitude: box.high.lat, longitude: box.high.lng },
          },
        },
      };
      if (pageToken) body.pageToken = pageToken;
      const res = await this.post('places:searchText', body, signal);
      out.push(...(res.places ?? []));
      pageToken = res.nextPageToken;
      if (!pageToken) break;
    }
    return out;
  }

  /** Nearby Search op afstand: vangt ook de nieuwe zaken met (nog) weinig reviews. */
  private async nearby(center: LatLng, radius: number, signal?: AbortSignal): Promise<GooglePlace[]> {
    const res = await this.post(
      'places:searchNearby',
      {
        includedTypes: ['restaurant'],
        maxResultCount: 20,
        rankPreference: 'DISTANCE',
        languageCode: 'nl',
        locationRestriction: {
          circle: { center: { latitude: center.lat, longitude: center.lng }, radius: Math.min(50000, radius) },
        },
      },
      signal,
    );
    return res.places ?? [];
  }

  async search(center: LatLng, radius: number, minRating: number, signal?: AbortSignal): Promise<Restaurant[]> {
    const box = bboxAround(center, radius);
    // Bij een grote straal splitsen we het gebied, anders mis je zaken door het maximum van 60 per zoekopdracht.
    const tiles = radius > 1800 ? splitBBox(box, 2) : [box];
    const pages = radius > 1800 ? 2 : 3;
    // Voor "nieuw" zoeken we ook vlakbij op afstand, en minRating iets lager, zodat opkomende zaken meekomen.
    const jobs: Promise<GooglePlace[]>[] = [
      ...tiles.map((t) => this.topRated(t, Math.min(minRating, 4.5), signal, pages)),
      this.nearby(center, Math.min(radius, 1200), signal),
    ];
    const settled = await Promise.allSettled(jobs);
    const firstError = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
    const ok = settled.filter((s): s is PromiseFulfilledResult<GooglePlace[]> => s.status === 'fulfilled');
    if (!ok.length && firstError) throw firstError.reason;
    const byId = new Map<string, Restaurant>();
    for (const s of ok) {
      for (const p of s.value) {
        if (byId.has(p.id)) continue;
        const r = mapGooglePlace(p, this.key);
        if (r) byId.set(p.id, r);
      }
    }
    return [...byId.values()];
  }
}
