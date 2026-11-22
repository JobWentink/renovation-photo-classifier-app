import type { EnrichedRestaurant, Filters, SearchCenter, Settings, VisitRecord } from './types';

/** Alles wat de gebruiker bewaart staat lokaal op het apparaat (localStorage). */
const K = {
  visits: 'smaakradar.visits.v1',
  settings: 'smaakradar.settings.v1',
  filters: 'smaakradar.filters.v1',
  recent: 'smaakradar.recent.v1',
  last: 'smaakradar.last.v1',
};

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}
function readArr<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function write(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* privémodus of opslag vol: de app werkt gewoon door */
  }
}

export const DEFAULT_SETTINGS: Settings = {
  source: 'auto',
  googleKey: (import.meta.env?.VITE_GOOGLE_MAPS_KEY as string | undefined) ?? '',
  theme: 'auto',
  newWindowDays: 365,
};

export const DEFAULT_FILTERS: Filters = {
  show: 'leuk',
  minRating: 4.5,
  radius: 1500,
  openNow: false,
  hideVisited: false,
  onlyWishlist: false,
  prices: [],
  cuisine: '',
  sort: 'match',
  query: '',
};

type Listener = () => void;

export class Store {
  visits: Record<string, VisitRecord> = read(K.visits, {});
  settings: Settings = read(K.settings, DEFAULT_SETTINGS);
  filters: Filters = { ...read(K.filters, DEFAULT_FILTERS), cuisine: '', query: '', onlyWishlist: false };
  recent: SearchCenter[] = readArr(K.recent);
  last: SearchCenter | null = read<SearchCenter | null>(K.last, null);
  private listeners = new Set<Listener>();

  constructor() {
    if (!this.settings.googleKey && DEFAULT_SETTINGS.googleKey) this.settings.googleKey = DEFAULT_SETTINGS.googleKey;
  }

  onVisits(fn: Listener) {
    this.listeners.add(fn);
  }
  private emit() {
    write(K.visits, this.visits);
    this.listeners.forEach((l) => l());
  }

  private upsert(r: EnrichedRestaurant | VisitRecord, patch: Partial<VisitRecord>): VisitRecord {
    const cur = this.visits[r.id];
    const next: VisitRecord = {
      ...cur,
      id: r.id,
      name: r.name,
      location: r.location,
      address: r.address ?? cur?.address,
      cuisine: r.cuisine ?? cur?.cuisine,
      cuisineEmoji: r.cuisineEmoji ?? cur?.cuisineEmoji,
      rating: r.rating ?? cur?.rating,
      ...patch,
      updatedAt: Date.now(),
    };
    if (!next.visited && !next.wishlist && !next.note && !next.myRating) {
      delete this.visits[r.id];
    } else {
      this.visits[r.id] = next;
    }
    this.emit();
    return next;
  }

  toggleVisited(r: EnrichedRestaurant | VisitRecord): boolean {
    const now = !this.visits[r.id]?.visited;
    this.upsert(r, {
      visited: now,
      visitedOn: now ? this.visits[r.id]?.visitedOn ?? new Date().toISOString().slice(0, 10) : undefined,
      // Bezocht? Dan hoeft hij niet meer op het verlanglijstje
      wishlist: now ? false : this.visits[r.id]?.wishlist,
    });
    return now;
  }
  toggleWishlist(r: EnrichedRestaurant | VisitRecord): boolean {
    const now = !this.visits[r.id]?.wishlist;
    this.upsert(r, { wishlist: now });
    return now;
  }
  updateVisit(r: EnrichedRestaurant | VisitRecord, patch: Partial<VisitRecord>) {
    this.upsert(r, patch);
  }

  saveSettings() {
    write(K.settings, this.settings);
  }
  saveFilters() {
    write(K.filters, this.filters);
  }
  remember(c: SearchCenter) {
    this.last = c;
    write(K.last, c);
    this.recent = [c, ...this.recent.filter((r) => r.label !== c.label)].slice(0, 5);
    write(K.recent, this.recent);
  }

  exportJson(): string {
    return JSON.stringify({ app: 'smaakradar', version: 1, exportedAt: new Date().toISOString(), visits: this.visits }, null, 2);
  }
  importJson(text: string): number {
    const j = JSON.parse(text);
    const v = j?.visits;
    if (!v || typeof v !== 'object') throw new Error('Dit is geen Smaakradar-backup');
    let n = 0;
    for (const [id, rec] of Object.entries(v as Record<string, VisitRecord>)) {
      if (!rec?.name || !rec?.location) continue;
      const cur = this.visits[id];
      if (!cur || (rec.updatedAt ?? 0) > cur.updatedAt) {
        this.visits[id] = { ...rec, id };
        n++;
      }
    }
    this.emit();
    return n;
  }
  clearAll() {
    this.visits = {};
    this.emit();
  }
}
