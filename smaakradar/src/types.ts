export interface LatLng {
  lat: number;
  lng: number;
}

export type Source = 'google' | 'osm' | 'demo';

export interface NewSignal {
  /** 0..100: hoe zeker zijn we dat dit een nieuwe zaak is */
  score: number;
  /** Korte, menselijke uitleg ("Geopend in maart 2026") */
  reason: string;
}

export interface Restaurant {
  /** Stabiele id: google place id, "osm:node/123" of "demo:..." */
  id: string;
  name: string;
  location: LatLng;
  address?: string;
  rating?: number;
  ratingCount?: number;
  /** 1..4 (€ t/m €€€€) */
  priceLevel?: number;
  cuisine?: string;
  cuisineEmoji?: string;
  openNow?: boolean;
  openingHours?: string[];
  website?: string;
  phone?: string;
  mapsUrl?: string;
  photoUrl?: string;
  /** Datum waarop de zaak opende, indien bekend (ISO) */
  openedOn?: string;
  newSignals: NewSignal[];
  sources: Source[];
  /** Ook ingevuld bij OSM-matches in Google-modus */
  osmId?: string;
  googleId?: string;
}

export interface EnrichedRestaurant extends Restaurant {
  distance: number; // meters vanaf het zoekadres
  newScore: number; // 0..100
  isNew: boolean;
  isTop: boolean;
  smaakScore: number; // gewogen rating
}

export interface VisitRecord {
  id: string;
  name: string;
  location: LatLng;
  address?: string;
  cuisineEmoji?: string;
  cuisine?: string;
  rating?: number;
  visitedOn?: string; // ISO date (YYYY-MM-DD)
  myRating?: number; // 1..5
  note?: string;
  wishlist?: boolean;
  visited?: boolean;
  updatedAt: number;
}

export type ShowMode = 'leuk' | 'top' | 'nieuw' | 'alles';
export type SortMode = 'match' | 'rating' | 'distance' | 'reviews' | 'new';

export interface Filters {
  show: ShowMode;
  minRating: number;
  radius: number; // meters
  openNow: boolean;
  hideVisited: boolean;
  onlyWishlist: boolean;
  prices: number[]; // leeg = alles
  cuisine: string; // '' = alles
  sort: SortMode;
  query: string;
}

export interface SearchCenter extends LatLng {
  label: string;
}

export interface Settings {
  source: 'auto' | 'google' | 'osm' | 'demo';
  googleKey: string;
  theme: 'auto' | 'light' | 'dark';
  /** Dagen waarbinnen een zaak als "nieuw" telt */
  newWindowDays: number;
}

export interface SearchResult {
  restaurants: Restaurant[];
  sourceUsed: Source;
  warnings: string[];
  apiCalls: number;
}
