import type { EnrichedRestaurant, VisitRecord } from '../types';
import { formatDistance, travelMinutes } from '../geo';

export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

export const fmtRating = (r?: number) => (r === undefined ? '–' : r.toFixed(1).replace('.', ','));
export const fmtCount = (n?: number) => (n === undefined ? '' : n.toLocaleString('nl-NL'));
export const price = (p?: number) => (p ? '€'.repeat(p) : '');

export function stars(r: number | undefined, size = 'sm'): string {
  if (r === undefined) return '';
  const pct = Math.max(0, Math.min(100, (r / 5) * 100));
  return `<span class="stars stars--${size}" style="--pct:${pct}%" aria-label="${fmtRating(r)} van 5 sterren"></span>`;
}

export const ICONS = {
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  heart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.5s-7.5-4.6-9.3-9.4C1.5 7.8 3.7 4.5 7 4.5c2 0 3.6 1.1 5 3 1.4-1.9 3-3 5-3 3.3 0 5.5 3.3 4.3 6.6-1.8 4.8-9.3 9.4-9.3 9.4z" fill="currentColor"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  route: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 19a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM18 10a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM8.5 16.5H15a3 3 0 000-6H9a3 3 0 010-6h6.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  globe: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  phone: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h3.5l1.5 4.5-2.2 1.4a11 11 0 005.3 5.3l1.4-2.2L19 14.5V18a2 2 0 01-2 2A15 15 0 013 6a2 2 0 012-2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  share: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3m0 0L7.5 7.5M12 3l4.5 4.5M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  map: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 1113 0c0 5.4-6.5 11-6.5 11z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="10" r="2.4" fill="currentColor"/></svg>',
};

function thumb(r: { id: string; name: string; cuisineEmoji?: string }, cls = 'thumb'): string {
  const hue = hashHue(r.name + r.id);
  return `<div class="${cls}" style="--h:${hue}" aria-hidden="true"><span>${r.cuisineEmoji ?? '🍽️'}</span></div>`;
}

function travel(d: number): string {
  return `<span title="Fietsen">🚲 ${travelMinutes(d, 'bike')} min</span><span title="Lopen">🚶 ${travelMinutes(d, 'walk')} min</span><span>${formatDistance(d)}</span>`;
}

export function newReason(r: EnrichedRestaurant): string {
  const best = [...r.newSignals].sort((a, b) => b.score - a.score)[0];
  return best?.reason ?? '';
}

export function cardHtml(r: EnrichedRestaurant, v: VisitRecord | undefined, hasRatings: boolean, selected: boolean): string {
  const rating =
    r.rating !== undefined
      ? `<span class="rating ${r.isTop ? 'rating--top' : ''}">★ ${fmtRating(r.rating)}</span><span class="muted">(${fmtCount(r.ratingCount)})</span>`
      : hasRatings
        ? '<span class="muted">nog geen rating</span>'
        : '';
  const meta = [rating, price(r.priceLevel) && `<span>${price(r.priceLevel)}</span>`, r.cuisine && `<span>${esc(r.cuisine)}</span>`]
    .filter(Boolean)
    .join('<span class="dot">·</span>');
  const open =
    r.openNow === true ? '<span class="open">Nu open</span>' : r.openNow === false ? '<span class="closed">Gesloten</span>' : '';
  const badges = [
    r.isNew ? `<span class="badge badge--new">✨ Nieuw</span><span class="badge-reason">${esc(newReason(r))}</span>` : '',
    v?.visited ? `<span class="badge badge--visited">✓ Bezocht${v.myRating ? ` · jij: ${'★'.repeat(v.myRating)}` : ''}</span>` : '',
  ]
    .filter(Boolean)
    .join('');
  return `<article class="card ${selected ? 'is-selected' : ''} ${v?.visited ? 'is-visited' : ''}" data-id="${esc(r.id)}" tabindex="0" role="button" aria-label="${esc(r.name)}">
    ${thumb(r)}
    <div class="card-body">
      <h3>${esc(r.name)}</h3>
      <div class="meta">${meta}</div>
      <div class="meta meta--sub">${travel(r.distance)}${open}</div>
      ${badges ? `<div class="badges">${badges}</div>` : ''}
    </div>
    <div class="card-actions">
      <button class="act act--visit ${v?.visited ? 'on' : ''}" data-act="visit" aria-pressed="${!!v?.visited}" title="${v?.visited ? 'Bezocht (klik om ongedaan te maken)' : 'Afvinken als bezocht'}">${ICONS.check}</button>
      <button class="act act--wish ${v?.wishlist ? 'on' : ''}" data-act="wish" aria-pressed="${!!v?.wishlist}" title="Wil ik heen">${ICONS.heart}</button>
    </div>
  </article>`;
}

export function mineRowHtml(v: VisitRecord, dist?: number): string {
  const sub = [
    v.cuisine && esc(v.cuisine),
    v.visited && v.visitedOn ? `bezocht ${new Date(v.visitedOn).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' })}` : '',
    dist !== undefined ? formatDistance(dist) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return `<article class="card card--mini ${v.visited ? 'is-visited' : ''}" data-id="${esc(v.id)}" tabindex="0" role="button">
    ${thumb(v)}
    <div class="card-body">
      <h3>${esc(v.name)}</h3>
      <div class="meta">${v.myRating ? `<span class="rating rating--mine">${'★'.repeat(v.myRating)}${'☆'.repeat(5 - v.myRating)}</span>` : v.rating ? `<span class="rating">★ ${fmtRating(v.rating)}</span>` : ''}<span class="muted">${sub}</span></div>
      ${v.note ? `<p class="note">“${esc(v.note)}”</p>` : ''}
    </div>
    <div class="card-actions">
      <button class="act act--visit ${v.visited ? 'on' : ''}" data-act="visit" aria-pressed="${!!v.visited}" title="Bezocht">${ICONS.check}</button>
      <button class="act act--wish ${v.wishlist ? 'on' : ''}" data-act="wish" aria-pressed="${!!v.wishlist}" title="Wil ik heen">${ICONS.heart}</button>
    </div>
  </article>`;
}

export function detailHtml(r: EnrichedRestaurant, v: VisitRecord | undefined, from: { lat: number; lng: number }): string {
  const isDemoPhoto = r.photoUrl?.startsWith('demo-hue:');
  const hue = isDemoPhoto ? +r.photoUrl!.split(':')[1] : hashHue(r.name + r.id);
  const hero =
    r.photoUrl && !isDemoPhoto
      ? `<div class="hero" style="--h:${hue}"><img src="${esc(r.photoUrl)}" alt="" loading="lazy" onerror="this.remove()"><span class="hero-emoji">${r.cuisineEmoji ?? '🍽️'}</span></div>`
      : `<div class="hero" style="--h:${hue}"><span class="hero-emoji">${r.cuisineEmoji ?? '🍽️'}</span></div>`;
  const dir = `https://www.google.com/maps/dir/?api=1&origin=${from.lat},${from.lng}&destination=${encodeURIComponent(r.name)}&destination_place_id=${r.googleId ?? ''}&travelmode=bicycling`;
  const dirFallback = `https://www.google.com/maps/dir/?api=1&origin=${from.lat},${from.lng}&destination=${r.location.lat},${r.location.lng}&travelmode=bicycling`;
  const maps = r.mapsUrl ?? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(r.name + ' ' + (r.address ?? ''))}`;
  const signals = r.newSignals.length
    ? `<div class="newbox ${r.isNew ? 'is-new' : ''}"><strong>${r.isNew ? '✨ Waarschijnlijk nieuw' : 'Nieuw-check'}</strong> <span class="muted">(${r.newScore}% zeker)</span><ul>${r.newSignals
        .map((s) => `<li>${esc(s.reason)}</li>`)
        .join('')}</ul></div>`
    : '';
  const hours = r.openingHours?.length
    ? `<details class="hours"><summary>Openingstijden ${r.openNow === true ? '<span class="open">Nu open</span>' : r.openNow === false ? '<span class="closed">Nu gesloten</span>' : ''}</summary><ul>${r.openingHours.map((h) => `<li>${esc(h)}</li>`).join('')}</ul></details>`
    : '';
  const myStars = [1, 2, 3, 4, 5]
    .map((n) => `<button class="mystar ${v?.myRating && n <= v.myRating ? 'on' : ''}" data-star="${n}" aria-label="${n} sterren">★</button>`)
    .join('');
  const visitBox = v?.visited
    ? `<div class="visitbox">
        <div class="visitbox-row"><label>Bezocht op <input type="date" id="visitDate" value="${esc(v.visitedOn ?? '')}"></label></div>
        <div class="visitbox-row"><span>Jouw oordeel</span><div class="mystars">${myStars}</div></div>
        <textarea id="visitNote" rows="2" placeholder="Wat heb je gegeten? Wat was top?">${esc(v.note ?? '')}</textarea>
      </div>`
    : '';
  return `<div class="detail-inner" data-id="${esc(r.id)}">
    <div class="detail-top">
      <button class="icon-btn" data-act="back" aria-label="Terug naar de lijst">${ICONS.back}</button>
      <span class="muted">${r.sources.map((s) => ({ google: 'Google', osm: 'OpenStreetMap', demo: 'Demo' })[s]).join(' + ')}</span>
    </div>
    ${hero}
    <h2>${esc(r.name)}</h2>
    <div class="detail-rating">
      ${r.rating !== undefined ? `<strong class="big">${fmtRating(r.rating)}</strong>${stars(r.rating, 'md')}<span class="muted">${fmtCount(r.ratingCount)} reviews</span>` : '<span class="muted">Nog geen rating bekend</span>'}
    </div>
    <div class="meta">${[price(r.priceLevel), r.cuisine && `${r.cuisineEmoji ?? ''} ${esc(r.cuisine)}`, r.openedOn ? `sinds ${new Date(r.openedOn).toLocaleDateString('nl-NL', { month: 'long', year: 'numeric' })}` : ''].filter(Boolean).join('<span class="dot">·</span>')}</div>
    <div class="meta meta--sub">${travel(r.distance)}</div>
    ${r.address ? `<p class="address">${ICONS.map}${esc(r.address)}</p>` : ''}
    <div class="big-actions">
      <button class="btn btn--visit ${v?.visited ? 'on' : ''}" data-act="visit">${ICONS.check}<span>${v?.visited ? 'Bezocht!' : 'Afvinken'}</span></button>
      <button class="btn btn--wish ${v?.wishlist ? 'on' : ''}" data-act="wish">${ICONS.heart}<span>${v?.wishlist ? 'Op je lijstje' : 'Wil ik heen'}</span></button>
    </div>
    ${visitBox}
    ${signals}
    <div class="link-row">
      <a class="chip-link" href="${esc(r.googleId ? dir : dirFallback)}" target="_blank" rel="noopener">${ICONS.route}Route</a>
      <a class="chip-link" href="${esc(maps)}" target="_blank" rel="noopener">${ICONS.map}Google Maps</a>
      ${r.website ? `<a class="chip-link" href="${esc(r.website)}" target="_blank" rel="noopener">${ICONS.globe}Website</a>` : ''}
      ${r.phone ? `<a class="chip-link" href="tel:${esc(r.phone.replace(/\s/g, ''))}">${ICONS.phone}Bellen</a>` : ''}
      <button class="chip-link" data-act="share">${ICONS.share}Delen</button>
    </div>
    ${hours}
  </div>`;
}
