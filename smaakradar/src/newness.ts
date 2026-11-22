import type { NewSignal } from './types';

const MONTHS = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];

export function monthLabel(d: Date): string {
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * Parse een OSM-datum: "2026", "2026-03", "2026-03-14", "~2025", "2025-05..2025-06".
 * Geeft de vroegste plausibele datum terug.
 */
export function parseOsmDate(v?: string): Date | undefined {
  if (!v) return undefined;
  const m = v.trim().replace(/^~/, '').match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/);
  if (!m) return undefined;
  const y = +m[1];
  const mo = m[2] ? +m[2] - 1 : 0;
  const d = m[3] ? +m[3] : 1;
  if (y < 1800 || mo > 11) return undefined;
  return new Date(Date.UTC(y, mo, d));
}

const DAY = 86400000;

/**
 * Signalen uit OpenStreetMap:
 * - opening_date / start_date (sterk)
 * - het object is pas kort geleden op de kaart gezet (version 1-2 & recente timestamp) (middel)
 */
export function osmNewSignals(
  tags: Record<string, string>,
  meta: { version?: number; timestamp?: string },
  now: Date,
  windowDays: number,
): { signals: NewSignal[]; openedOn?: string } {
  const signals: NewSignal[] = [];
  let openedOn: string | undefined;
  const opened = parseOsmDate(tags['opening_date'] ?? tags['start_date']);
  if (opened) {
    const age = (now.getTime() - opened.getTime()) / DAY;
    if (age < -1) {
      signals.push({ score: 70, reason: `Opent binnenkort (${monthLabel(opened)})` });
      openedOn = opened.toISOString().slice(0, 10);
    } else if (age <= windowDays) {
      signals.push({ score: 95, reason: `Geopend in ${monthLabel(opened)}` });
      openedOn = opened.toISOString().slice(0, 10);
    } else if (age <= windowDays * 2) {
      signals.push({ score: 45, reason: `Geopend in ${monthLabel(opened)}` });
      openedOn = opened.toISOString().slice(0, 10);
    }
  }
  if (meta.timestamp && meta.version !== undefined && meta.version <= 2) {
    const t = new Date(meta.timestamp);
    const age = (now.getTime() - t.getTime()) / DAY;
    if (age >= 0 && age <= windowDays) {
      signals.push({
        score: meta.version === 1 ? 65 : 50,
        reason: `Pas sinds ${monthLabel(t)} op de kaart`,
      });
    }
  }
  if (tags['not:yet'] === 'yes' || tags['disused:amenity'] || tags['opening_hours'] === 'opening soon') {
    signals.push({ score: 40, reason: 'Opent binnenkort' });
  }
  return { signals, openedOn };
}

/**
 * Signaal uit Google: weinig reviews (maar wel al een paar en goed beoordeeld) betekent
 * vaak een zaak die nog maar kort open is.
 */
export function googleNewSignals(ratingCount?: number, rating?: number): NewSignal[] {
  if (ratingCount === undefined || ratingCount === 0) {
    return [{ score: 40, reason: 'Nog geen Google-reviews' }];
  }
  if (rating !== undefined && rating < 3.8) return [];
  if (ratingCount <= 15) return [{ score: 60, reason: `Pas ${ratingCount} reviews: waarschijnlijk net open` }];
  if (ratingCount <= 40) return [{ score: 50, reason: `Pas ${ratingCount} reviews: nieuw of nog onontdekt` }];
  if (ratingCount <= 80) return [{ score: 25, reason: `Relatief weinig reviews (${ratingCount})` }];
  return [];
}

/** Combineer signalen: noisy-OR, zodat twee zwakke signalen samen sterker zijn dan één. */
export function combineNewScore(signals: NewSignal[]): number {
  if (!signals.length) return 0;
  const p = signals.reduce((acc, s) => acc * (1 - Math.min(99, s.score) / 100), 1);
  return Math.round((1 - p) * 100);
}

export const NEW_THRESHOLD = 50;
