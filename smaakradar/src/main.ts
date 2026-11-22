import './styles.css';
import type { EnrichedRestaurant, Restaurant, SearchCenter, Source, ShowMode, SortMode } from './types';
import { Store } from './store';
import { MapView } from './ui/map';
import { GoogleApiError, GoogleProvider } from './providers/google';
import { OsmProvider } from './providers/osm';
import { demoRestaurants } from './providers/demo';
import { geocode, reverse, suggest } from './providers/geocode';
import { applyFilters, cuisineCounts, enrich, levelFor, matchScore, mergeSources } from './logic';
import { cardHtml, detailHtml, esc, mineRowHtml } from './ui/render';
import { confetti, Sheet, toast } from './ui/fx';
import { distance, formatDistance } from './geo';

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel)!;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll<T>(sel)];

const store = new Store();

// ---------- Thema ----------
const darkMq = matchMedia('(prefers-color-scheme: dark)');
let mapView: MapView | undefined;
const isDark = () => (store.settings.theme === 'auto' ? darkMq.matches : store.settings.theme === 'dark');
function applyTheme() {
  document.documentElement.dataset.theme = isDark() ? 'dark' : 'light';
  mapView?.setDark(isDark());
}

// ---------- State ----------
interface State {
  center: SearchCenter | null;
  raw: Restaurant[];
  all: EnrichedRestaurant[];
  shown: EnrichedRestaurant[];
  source: Source | null;
  loading: boolean;
  error: string | null;
  warnings: string[];
  selected: string | null;
  tab: 'discover' | 'mine';
  mineView: 'wish' | 'visited';
  searchedRadius: number;
  searchedMinRating: number;
}
const S: State = {
  center: null,
  raw: [],
  all: [],
  shown: [],
  source: null,
  loading: false,
  error: null,
  warnings: [],
  selected: null,
  tab: 'discover',
  mineView: 'wish',
  searchedRadius: 0,
  searchedMinRating: 5,
};
let apiCalls = 0;
const cache = new Map<string, { raw: Restaurant[]; source: Source; warnings: string[] }>();

applyTheme();
darkMq.addEventListener('change', applyTheme);

const map = new MapView($('#map'), isDark());
mapView = map;
const panel = $('#panel');
const sheet = new Sheet(panel, $('#sheetHead'));
sheet.onChange = () => setTimeout(() => map.invalidate(), 320);
map.onSelect = (id) => openDetail(id, false);

const hasRatings = () => S.source === 'google' || S.source === 'demo';
const effectiveSource = (): Source => {
  const s = store.settings.source;
  if (s === 'auto') return store.settings.googleKey ? 'google' : 'osm';
  if (s === 'google' && !store.settings.googleKey) return 'osm';
  return s;
};

// ---------- Zoeken ----------
let searchAbort: AbortController | null = null;

async function runSearch(center: SearchCenter, opts: { fly?: boolean } = {}) {
  S.center = center;
  store.remember(center);
  ($('#address') as HTMLInputElement).value = center.label;
  updateUrl();
  const radius = store.filters.radius;
  map.setCenter(center, radius, opts.fly !== false, sheet.coveredPx());
  closeDetail(false);
  switchTab('discover');

  const source = effectiveSource();
  const minR = store.filters.minRating;
  const key = `${source}:${center.lat.toFixed(4)},${center.lng.toFixed(4)}:${radius}:${source === 'google' ? minR : ''}:${store.settings.newWindowDays}`;
  searchAbort?.abort();
  const ctrl = new AbortController();
  searchAbort = ctrl;

  S.loading = true;
  S.error = null;
  renderDiscover();

  try {
    let result = cache.get(key);
    if (!result) {
      result = await fetchRestaurants(source, center, radius, minR, ctrl.signal);
      cache.set(key, result);
    }
    if (ctrl.signal.aborted) return;
    S.raw = result.raw;
    S.source = result.source;
    S.warnings = result.warnings;
    S.searchedRadius = radius;
    S.searchedMinRating = minR;
    for (const w of result.warnings) toast(w);
  } catch (e) {
    if ((e as Error).name === 'AbortError') return;
    S.error = (e as Error).message || 'Er ging iets mis bij het zoeken.';
    S.raw = [];
  } finally {
    if (searchAbort === ctrl) {
      S.loading = false;
      recompute();
      renderDiscover();
    }
  }
}

async function fetchRestaurants(source: Source, c: SearchCenter, radius: number, minR: number, signal: AbortSignal) {
  const warnings: string[] = [];
  const windowDays = store.settings.newWindowDays;
  if (source === 'demo') {
    await new Promise((r) => setTimeout(r, 450)); // even laten "zoeken" voor het gevoel
    return { raw: demoRestaurants(c, radius), source: 'demo' as Source, warnings };
  }
  const osm = new OsmProvider(windowDays);
  if (source === 'google') {
    const g = new GoogleProvider(store.settings.googleKey);
    const [gr, or] = await Promise.allSettled([g.search(c, radius, minR, signal), osm.search(c, radius, signal)]);
    apiCalls += g.calls;
    if (gr.status === 'fulfilled') {
      const osmList = or.status === 'fulfilled' ? or.value : [];
      if (or.status === 'rejected') warnings.push('OpenStreetMap reageerde niet: "nieuw" is minder nauwkeurig.');
      return { raw: mergeSources(gr.value, osmList), source: 'google' as Source, warnings };
    }
    const err = gr.reason as Error;
    if (err.name === 'AbortError') throw err;
    const hint = err instanceof GoogleApiError && (err.status === 403 || err.status === 400) ? ' Controleer je API-sleutel in Instellingen.' : '';
    if (or.status === 'fulfilled') {
      warnings.push(`Google gaf een fout: ${err.message}.${hint} Je ziet nu OpenStreetMap-resultaten.`);
      return { raw: or.value, source: 'osm' as Source, warnings };
    }
    throw new Error(`Google: ${err.message}.${hint}`);
  }
  return { raw: await osm.search(c, radius, signal), source: 'osm' as Source, warnings };
}

function recompute() {
  if (!S.center) return;
  S.all = enrich(S.raw, S.center, store.filters.minRating);
  S.shown = applyFilters(S.all, store.filters, store.visits, hasRatings());
  renderMap();
}

function renderMap() {
  const extras = Object.values(store.visits);
  map.render(S.shown, store.visits, extras);
}

// ---------- Ontdekken-paneel ----------
function renderDiscover() {
  const body = $('#discoverBody');
  if (!S.center) {
    body.innerHTML = welcomeHtml();
    $('#surpriseBtn').hidden = true;
    $('#recenterBtn').hidden = true;
    $('#legend').hidden = true;
    return;
  }
  if (!$('#filters', body)) body.innerHTML = `<div id="summary"></div><div id="filters" class="filters"></div><div id="results" class="results"></div>`;
  renderSummary();
  renderFilters();
  renderResults();
  $('#surpriseBtn').hidden = !S.shown.length;
  $('#recenterBtn').hidden = false;
  $('#legend').hidden = !hasRatings();
}

function welcomeHtml(): string {
  const recent = store.recent
    .map((r, i) => `<button class="recent" data-recent="${i}">🕘 ${esc(r.label)}</button>`)
    .join('');
  return `<div class="welcome">
    <div class="welcome-art" aria-hidden="true"><span>🍝</span><span>🍣</span><span>🥘</span><span>🌮</span><span>🍜</span></div>
    <h1>Waar ga je <em>vanavond</em> eten?</h1>
    <p>Vul je adres in. Smaakradar zoekt de restaurants met <b>4,5★ of meer</b> én de <b>nieuwe zaken</b> bij jou in de buurt. Vink af waar je bent geweest en bouw je eigen eetlijst op.</p>
    <div class="welcome-actions">
      <button class="btn btn--primary" data-act="locate">📍 Gebruik mijn locatie</button>
      <button class="btn btn--ghost" data-act="demo">✨ Probeer de demo</button>
    </div>
    ${recent ? `<div class="recents"><h4>Recent gezocht</h4>${recent}</div>` : ''}
    <ul class="features">
      <li><b>⭐ Alleen de toppers</b><span>Filter op Google-rating, met een slimme score die ook het aantal reviews meeweegt.</span></li>
      <li><b>✨ Nieuw in de buurt</b><span>Herkent nieuwe zaken aan de openingsdatum, recente kaartwijzigingen en weinig reviews.</span></li>
      <li><b>✓ Jouw eetdagboek</b><span>Vink af, geef je eigen sterren, schrijf notities, en kom een level hoger.</span></li>
      <li><b>📱 Overal</b><span>Werkt op telefoon, tablet en laptop. Installeer hem als app.</span></li>
    </ul>
    ${!store.settings.googleKey ? `<p class="hint center">Tip: met een <button class="linklike" data-act="settings">Google API-sleutel</button> krijg je echte ratings en foto's.</p>` : ''}
  </div>`;
}

function renderSummary() {
  const el = $('#summary');
  if (!el || !S.center) return;
  const top = S.all.filter((r) => r.isTop && r.distance <= store.filters.radius).length;
  const nw = S.all.filter((r) => r.isNew && r.distance <= store.filters.radius).length;
  const visitedHere = S.all.filter((r) => store.visits[r.id]?.visited && r.distance <= store.filters.radius).length;
  const srcLabel = { google: 'Google', osm: 'OpenStreetMap', demo: 'Demo' }[S.source ?? effectiveSource()];
  el.className = 'summary';
  el.innerHTML = `
    <div class="where"><span class="where-label" title="${esc(S.center.label)}">📍 ${esc(S.center.label)}</span><span class="pill pill--${S.source ?? ''}">${srcLabel}</span></div>
    ${S.loading ? '<div class="counts"><span class="shimmer-text">Restaurants zoeken…</span></div>' : `
    <div class="counts">
      <span><b>${S.shown.length}</b> getoond</span>
      ${hasRatings() ? `<span><b>${top}</b> met ${store.filters.minRating.toString().replace('.', ',')}★+</span>` : `<span><b>${S.all.length}</b> restaurants</span>`}
      <span><b>${nw}</b> nieuw</span>
      <span><b>${visitedHere}</b> bezocht</span>
    </div>`}
    ${S.source === 'osm' && !S.loading ? `<div class="banner">OpenStreetMap heeft geen ratings. Je ziet alle restaurants en de nieuwe zaken. <button class="linklike" data-act="settings">Google-sleutel toevoegen</button> of <button class="linklike" data-act="demo">bekijk de demo</button>.</div>` : ''}
    ${S.source === 'demo' && !S.loading ? `<div class="banner banner--demo">Demo-modus: deze restaurants zijn verzonnen. <button class="linklike" data-act="settings">Echte data aanzetten</button></div>` : ''}
  `;
}

const SHOW_OPTS: [ShowMode, string, string][] = [
  ['leuk', '🔥', 'Leuk'],
  ['top', '⭐', 'Top'],
  ['nieuw', '✨', 'Nieuw'],
  ['alles', '🍽️', 'Alles'],
];
const SORT_OPTS: [SortMode, string][] = [
  ['match', 'Beste match'],
  ['rating', 'Hoogste rating'],
  ['distance', 'Dichtstbij'],
  ['reviews', 'Meeste reviews'],
  ['new', 'Nieuwste eerst'],
];

function renderFilters() {
  const el = $('#filters');
  const f = store.filters;
  const ratings = hasRatings();
  const cuisines = cuisineCounts(S.all.filter((r) => r.distance <= f.radius));
  const showTitle: Record<ShowMode, string> = {
    leuk: ratings ? `Top (${f.minRating.toString().replace('.', ',')}★+) én nieuw` : 'Alle restaurants',
    top: 'Alleen hoog beoordeeld',
    nieuw: 'Alleen nieuwe zaken',
    alles: 'Alles in de buurt',
  };
  el.innerHTML = `
    <div class="seg" role="radiogroup" aria-label="Wat wil je zien?">
      ${SHOW_OPTS.filter(([k]) => ratings || k !== 'top')
        .map(([k, e, l]) => `<button role="radio" aria-checked="${f.show === k}" class="${f.show === k ? 'on' : ''}" data-show="${k}" title="${showTitle[k]}"><span>${e}</span>${l}</button>`)
        .join('')}
    </div>
    <div class="range-row">
      <label for="radius">Straal</label>
      <input type="range" id="radius" min="300" max="5000" step="100" value="${f.radius}" />
      <output id="radiusOut">${formatDistance(f.radius)}</output>
    </div>
    <div class="chips" role="group" aria-label="Filters">
      ${ratings ? `<label class="chip chip--select">⭐<select id="minRating" aria-label="Minimale rating">${[4.0, 4.3, 4.5, 4.7, 4.8]
        .map((v) => `<option value="${v}" ${v === f.minRating ? 'selected' : ''}>${v.toFixed(1).replace('.', ',')}+</option>`)
        .join('')}</select></label>` : ''}
      ${ratings ? `<button class="chip ${f.openNow ? 'on' : ''}" data-toggle="openNow">🟢 Nu open</button>` : ''}
      <button class="chip ${f.hideVisited ? 'on' : ''}" data-toggle="hideVisited">Nog niet geweest</button>
      <button class="chip ${f.onlyWishlist ? 'on' : ''}" data-toggle="onlyWishlist">♥ Mijn lijstje</button>
      ${ratings ? [1, 2, 3, 4].map((p) => `<button class="chip chip--price ${f.prices.includes(p) ? 'on' : ''}" data-price="${p}" aria-label="Prijsklasse ${p}">${'€'.repeat(p)}</button>`).join('') : ''}
      <label class="chip chip--select"><select id="cuisine" aria-label="Keuken"><option value="">Alle keukens</option>${cuisines
        .map(([c, e, n]) => `<option value="${esc(c)}" ${c === f.cuisine ? 'selected' : ''}>${e} ${esc(c)} (${n})</option>`)
        .join('')}</select></label>
      <label class="chip chip--select">↕<select id="sort" aria-label="Sorteren">${SORT_OPTS.filter(([k]) => ratings || (k !== 'rating' && k !== 'reviews'))
        .map(([k, l]) => `<option value="${k}" ${k === f.sort ? 'selected' : ''}>${l}</option>`)
        .join('')}</select></label>
    </div>
    <div class="list-search"><input id="listQuery" type="search" placeholder="Zoek in resultaten (naam, keuken…)" value="${esc(f.query)}" aria-label="Zoek in resultaten" /></div>
  `;
}

function renderResults() {
  const el = $('#results');
  if (!el) return;
  if (S.loading) {
    el.innerHTML = Array.from({ length: 6 }, () => '<div class="card skeleton"><div class="thumb"></div><div class="card-body"><i></i><i></i><i></i></div></div>').join('');
    return;
  }
  if (S.error) {
    el.innerHTML = `<div class="empty"><div class="empty-emoji">😵‍💫</div><h3>Dat ging mis</h3><p>${esc(S.error)}</p><div class="btn-row center"><button class="btn btn--primary" data-act="retry">Opnieuw proberen</button><button class="btn btn--ghost" data-act="demo">Bekijk de demo</button></div></div>`;
    return;
  }
  if (!S.shown.length) {
    const f = store.filters;
    const tips = [];
    if (f.radius < 3000) tips.push('<button class="linklike" data-act="wider">vergroot de straal</button>');
    if (f.show !== 'alles') tips.push('<button class="linklike" data-act="showall">toon alles</button>');
    if (f.cuisine || f.prices.length || f.openNow || f.hideVisited || f.onlyWishlist || f.query) tips.push('<button class="linklike" data-act="clearfilters">wis filters</button>');
    el.innerHTML = `<div class="empty"><div class="empty-emoji">🍽️</div><h3>Niets gevonden</h3><p>Met deze filters vinden we niets. ${tips.length ? `Tip: ${tips.join(' of ')}.` : ''}</p></div>`;
    return;
  }
  const visibleCount = Math.min(S.shown.length, renderLimit);
  el.innerHTML =
    S.shown
      .slice(0, visibleCount)
      .map((r) => cardHtml(r, store.visits[r.id], hasRatings(), r.id === S.selected))
      .join('') +
    (S.shown.length > visibleCount ? `<button class="btn btn--ghost more" data-act="more">Toon nog ${S.shown.length - visibleCount}</button>` : '') +
    `<p class="source-note">${S.source === 'google' ? 'Ratings: Google. Nieuw-detectie: Google + OpenStreetMap.' : S.source === 'osm' ? 'Data © OpenStreetMap-bijdragers' : 'Demo-data, verzonnen'}</p>`;
}
let renderLimit = 40;

function refresh() {
  recompute();
  renderSummary();
  renderResults();
  $('#surpriseBtn').hidden = !S.shown.length;
  renderMineCount();
}

// ---------- Detail ----------
let listScroll = 0;
function findRestaurant(id: string): EnrichedRestaurant | undefined {
  const r = S.all.find((x) => x.id === id);
  if (r) return r;
  const v = store.visits[id];
  if (!v) return undefined;
  return {
    ...v,
    newSignals: [],
    sources: id.startsWith('osm:') ? ['osm'] : id.startsWith('demo:') ? ['demo'] : ['google'],
    googleId: !id.includes(':') ? id : undefined,
    distance: S.center ? distance(S.center, v.location) : 0,
    newScore: 0,
    isNew: false,
    isTop: false,
    smaakScore: 0,
  };
}

function openDetail(id: string, pan = true) {
  const r = findRestaurant(id);
  if (!r) return;
  const pane = $('#pane-detail');
  if (pane.hidden) listScroll = panel.scrollTop;
  S.selected = id;
  pane.innerHTML = detailHtml(r, store.visits[id], S.center ?? r.location);
  $('#pane-discover').hidden = true;
  $('#pane-mine').hidden = true;
  pane.hidden = false;
  panel.classList.add('has-detail');
  panel.scrollTop = 0;
  if (sheet.state === 'peek') sheet.set('half');
  map.select(id, pan, sheet.coveredPx());
  renderMap();
}

function closeDetail(restore = true) {
  if (!S.selected && $('#pane-detail').hidden) return;
  S.selected = null;
  map.select(undefined);
  $('#pane-detail').hidden = true;
  panel.classList.remove('has-detail');
  $(`#pane-${S.tab}`).hidden = false;
  if (S.tab === 'discover') renderResults();
  else renderMine();
  renderMap();
  if (restore) panel.scrollTop = listScroll;
}

function rerenderDetail() {
  if (S.selected && !$('#pane-detail').hidden) {
    const r = findRestaurant(S.selected);
    if (r) $('#pane-detail').innerHTML = detailHtml(r, store.visits[r.id], S.center ?? r.location);
  }
}

// ---------- Mijn lijst ----------
function renderMineCount() {
  const n = Object.values(store.visits).filter((v) => v.visited).length;
  $('#mineCount').textContent = n ? String(n) : '';
}

function renderMine() {
  const el = $('#pane-mine');
  const all = Object.values(store.visits);
  const visited = all.filter((v) => v.visited).sort((a, b) => (b.visitedOn ?? '').localeCompare(a.visitedOn ?? '') || b.updatedAt - a.updatedAt);
  const wish = all.filter((v) => v.wishlist && !v.visited).sort((a, b) => b.updatedAt - a.updatedAt);
  const lvl = levelFor(visited.length);
  const prevMin = lvl.min;
  const progress = lvl.next ? Math.round(((visited.length - prevMin) / (lvl.next - prevMin)) * 100) : 100;
  const cuisines = new Set(visited.map((v) => v.cuisine).filter((c) => c && c !== 'Restaurant'));
  const rated = visited.filter((v) => v.myRating);
  const avg = rated.length ? (rated.reduce((s, v) => s + (v.myRating ?? 0), 0) / rated.length).toFixed(1).replace('.', ',') : '–';
  const tops = S.all.filter((r) => r.isTop && r.distance <= store.filters.radius);
  const topsVisited = tops.filter((r) => store.visits[r.id]?.visited).length;
  const list = S.mineView === 'wish' ? wish : visited;
  el.innerHTML = `
    <div class="level">
      <div class="level-emoji">${lvl.emoji}</div>
      <div class="level-body">
        <small>Jouw level</small>
        <h3>${lvl.name}</h3>
        <div class="bar"><i style="width:${progress}%"></i></div>
        <small class="muted">${lvl.next ? `Nog ${lvl.next - visited.length} restaurant${lvl.next - visited.length === 1 ? '' : 's'} tot het volgende level` : 'Hoogste level bereikt. Respect! 👑'}</small>
      </div>
    </div>
    <div class="stats">
      <div><b>${visited.length}</b><small>bezocht</small></div>
      <div><b>${wish.length}</b><small>op je lijstje</small></div>
      <div><b>${cuisines.size}</b><small>keukens</small></div>
      <div><b>${avg}</b><small>jouw gem. ★</small></div>
    </div>
    ${S.center && hasRatings() && tops.length ? `<div class="hood"><div><b>${topsVisited} van ${tops.length}</b> toprestaurants in je buurt bezocht</div><div class="bar bar--hood"><i style="width:${Math.round((topsVisited / tops.length) * 100)}%"></i></div></div>` : ''}
    <div class="seg seg--small" role="radiogroup">
      <button role="radio" class="${S.mineView === 'wish' ? 'on' : ''}" aria-checked="${S.mineView === 'wish'}" data-mine="wish">♥ Wil ik heen (${wish.length})</button>
      <button role="radio" class="${S.mineView === 'visited' ? 'on' : ''}" aria-checked="${S.mineView === 'visited'}" data-mine="visited">✓ Bezocht (${visited.length})</button>
    </div>
    <div class="results">
      ${list.length ? list.map((v) => mineRowHtml(v, S.center ? distance(S.center, v.location) : undefined)).join('') : `<div class="empty small"><div class="empty-emoji">${S.mineView === 'wish' ? '💭' : '🧾'}</div><p>${S.mineView === 'wish' ? 'Tik op ♥ bij een restaurant om het op je lijstje te zetten.' : 'Nog niets afgevinkt. Tik op ✓ als je ergens hebt gegeten.'}</p></div>`}
    </div>
  `;
}

function switchTab(tab: State['tab']) {
  S.tab = tab;
  $$('.tab').forEach((t) => {
    const on = t.dataset.tab === tab;
    t.classList.toggle('is-active', on);
    t.setAttribute('aria-selected', String(on));
  });
  if (!$('#pane-detail').hidden) closeDetail(false);
  $('#pane-discover').hidden = tab !== 'discover';
  $('#pane-mine').hidden = tab !== 'mine';
  if (tab === 'mine') renderMine();
}

// ---------- Acties ----------
function toggleVisit(id: string, ev?: MouseEvent) {
  const r = findRestaurant(id);
  if (!r) return;
  const now = store.toggleVisited(r);
  if (now) {
    if (ev) confetti(ev.clientX, ev.clientY);
    const n = Object.values(store.visits).filter((v) => v.visited).length;
    const lvl = levelFor(n);
    if (lvl.min === n && n > 0) toast(`${lvl.emoji} Level omhoog: ${lvl.name}!`);
    else toast(`✓ ${r.name} afgevinkt`, { label: 'Ongedaan maken', run: () => toggleVisit(id) });
  }
  afterVisitChange();
}
function toggleWish(id: string) {
  const r = findRestaurant(id);
  if (!r) return;
  const now = store.toggleWishlist(r);
  toast(now ? `♥ ${r.name} staat op je lijstje` : `${r.name} van je lijstje gehaald`);
  afterVisitChange();
}
function afterVisitChange() {
  S.shown = applyFilters(S.all, store.filters, store.visits, hasRatings());
  renderMap();
  renderMineCount();
  if (!$('#pane-detail').hidden) rerenderDetail();
  else if (S.tab === 'mine') renderMine();
  else if (S.center) {
    renderSummary();
    renderResults();
  }
}

function surprise() {
  const pool = S.shown.filter((r) => !store.visits[r.id]?.visited);
  const from = pool.length ? pool : S.shown;
  if (!from.length) return;
  // Gewogen loting: betere matches hebben meer kans
  const w = from.map((r) => Math.max(0.05, matchScore(r) - 3.5) ** 2);
  let x = Math.random() * w.reduce((a, b) => a + b, 0);
  let pick = from[0];
  for (let i = 0; i < from.length; i++) {
    x -= w[i];
    if (x <= 0) {
      pick = from[i];
      break;
    }
  }
  const btn = $('#surpriseBtn');
  btn.classList.add('spin');
  setTimeout(() => btn.classList.remove('spin'), 700);
  toast(`🎲 Wat dacht je van ${pick.name}?`);
  openDetail(pick.id);
}

async function share(r: EnrichedRestaurant) {
  const url = r.mapsUrl ?? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${r.name} ${r.address ?? ''}`)}`;
  const text = `${r.name}${r.rating ? ` (${r.rating.toFixed(1)}★)` : ''}: gevonden met Smaakradar`;
  try {
    if (navigator.share) await navigator.share({ title: r.name, text, url });
    else {
      await navigator.clipboard.writeText(`${text}\n${url}`);
      toast('Link gekopieerd 📋');
    }
  } catch {
    /* gebruiker annuleerde */
  }
}

function locate() {
  if (!navigator.geolocation) return toast('Je browser ondersteunt geen locatie.');
  const btn = $('#locateBtn');
  btn.classList.add('busy');
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { latitude: lat, longitude: lng } = pos.coords;
      const label = await reverse(lat, lng);
      btn.classList.remove('busy');
      runSearch({ lat, lng, label });
    },
    (err) => {
      btn.classList.remove('busy');
      toast(err.code === 1 ? 'Geen toestemming voor je locatie. Vul je adres in.' : 'Locatie niet gevonden. Vul je adres in.');
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 },
  );
}

function startDemo() {
  store.settings.source = 'demo';
  store.saveSettings();
  const c = S.center ?? store.last ?? { lat: 52.3676, lng: 4.9041, label: 'Amsterdam (demo)' };
  cache.clear();
  runSearch(c);
}

// ---------- URL (deelbare zoekopdracht) ----------
function updateUrl() {
  if (!S.center) return;
  const u = new URL(location.href);
  u.searchParams.set('lat', S.center.lat.toFixed(5));
  u.searchParams.set('lng', S.center.lng.toFixed(5));
  u.searchParams.set('q', S.center.label);
  u.searchParams.set('r', String(store.filters.radius));
  history.replaceState(null, '', u);
}

// ---------- Adres-autocomplete ----------
const input = $('#address') as HTMLInputElement;
const sugList = $('#suggestions');
let sugItems: SearchCenter[] = [];
let sugIdx = -1;
let sugTimer: number | undefined;
let sugAbort: AbortController | null = null;

function showSuggestions(items: SearchCenter[]) {
  sugItems = items;
  sugIdx = -1;
  sugList.hidden = !items.length;
  sugList.innerHTML = items.map((s, i) => `<li role="option" id="sug-${i}" data-i="${i}">📍 ${esc(s.label)}</li>`).join('');
}
input.addEventListener('input', () => {
  clearTimeout(sugTimer);
  const q = input.value;
  if (q.trim().length < 3) return showSuggestions([]);
  sugTimer = window.setTimeout(async () => {
    sugAbort?.abort();
    sugAbort = new AbortController();
    try {
      showSuggestions(await suggest(q, S.center ?? store.last ?? undefined, sugAbort.signal));
    } catch {
      /* stil falen: Enter werkt nog steeds via geocode */
    }
  }, 220);
});
input.addEventListener('keydown', (e) => {
  if (sugList.hidden) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    sugIdx = (sugIdx + (e.key === 'ArrowDown' ? 1 : -1) + sugItems.length) % sugItems.length;
    $$('li', sugList).forEach((li, i) => li.classList.toggle('active', i === sugIdx));
    input.setAttribute('aria-activedescendant', `sug-${sugIdx}`);
  } else if (e.key === 'Escape') showSuggestions([]);
});
input.addEventListener('blur', () => setTimeout(() => showSuggestions([]), 180));
sugList.addEventListener('mousedown', (e) => {
  const li = (e.target as HTMLElement).closest('li');
  if (!li) return;
  e.preventDefault();
  const s = sugItems[+li.dataset.i!];
  showSuggestions([]);
  input.blur();
  runSearch(s);
});
$('#searchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (sugIdx >= 0 && sugItems[sugIdx]) {
    const s = sugItems[sugIdx];
    showSuggestions([]);
    input.blur();
    return runSearch(s);
  }
  const q = input.value.trim();
  if (!q) return input.focus();
  showSuggestions([]);
  input.blur();
  if (sugItems[0] && sugItems[0].label.toLowerCase().startsWith(q.toLowerCase())) return runSearch(sugItems[0]);
  try {
    const c = await geocode(q);
    if (c) runSearch(c);
    else toast('Adres niet gevonden. Probeer straat + plaats.');
  } catch {
    toast('Adres zoeken lukt nu niet. Probeer het zo nog eens.');
  }
});
$('#locateBtn').addEventListener('click', locate);

// ---------- Events in het paneel (event delegation) ----------
panel.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const act = t.closest<HTMLElement>('[data-act]');
  const card = t.closest<HTMLElement>('.card[data-id]');
  const detailId = t.closest<HTMLElement>('.detail-inner')?.dataset.id;
  if (act) {
    const a = act.dataset.act!;
    const id = card?.dataset.id ?? detailId;
    e.stopPropagation();
    if (a === 'visit' && id) return toggleVisit(id, e);
    if (a === 'wish' && id) return toggleWish(id);
    if (a === 'back') return closeDetail();
    if (a === 'share' && id) {
      const r = findRestaurant(id);
      if (r) share(r);
      return;
    }
    if (a === 'locate') return locate();
    if (a === 'demo') return startDemo();
    if (a === 'settings') return openSettings();
    if (a === 'retry' && S.center) {
      cache.clear();
      return runSearch(S.center, { fly: false });
    }
    if (a === 'more') {
      renderLimit += 40;
      return renderResults();
    }
    if (a === 'wider') return setRadius(Math.min(5000, store.filters.radius * 2), true);
    if (a === 'showall') {
      store.filters.show = 'alles';
      store.saveFilters();
      renderFilters();
      return refresh();
    }
    if (a === 'clearfilters') {
      Object.assign(store.filters, { cuisine: '', prices: [], openNow: false, hideVisited: false, onlyWishlist: false, query: '' });
      store.saveFilters();
      renderFilters();
      return refresh();
    }
  }
  const recent = t.closest<HTMLElement>('[data-recent]');
  if (recent) return runSearch(store.recent[+recent.dataset.recent!]);
  const show = t.closest<HTMLElement>('[data-show]');
  if (show) {
    store.filters.show = show.dataset.show as ShowMode;
    store.saveFilters();
    renderFilters();
    renderLimit = 40;
    return refresh();
  }
  const toggle = t.closest<HTMLElement>('[data-toggle]');
  if (toggle) {
    const k = toggle.dataset.toggle as 'openNow' | 'hideVisited' | 'onlyWishlist';
    store.filters[k] = !store.filters[k];
    toggle.classList.toggle('on', store.filters[k]);
    store.saveFilters();
    return refresh();
  }
  const pr = t.closest<HTMLElement>('[data-price]');
  if (pr) {
    const p = +pr.dataset.price!;
    const ps = store.filters.prices;
    store.filters.prices = ps.includes(p) ? ps.filter((x) => x !== p) : [...ps, p];
    pr.classList.toggle('on');
    store.saveFilters();
    return refresh();
  }
  const mine = t.closest<HTMLElement>('[data-mine]');
  if (mine) {
    S.mineView = mine.dataset.mine as State['mineView'];
    return renderMine();
  }
  const star = t.closest<HTMLElement>('[data-star]');
  if (star && detailId) {
    const r = findRestaurant(detailId);
    const n = +star.dataset.star!;
    if (r) store.updateVisit(r, { myRating: store.visits[detailId]?.myRating === n ? undefined : n });
    return afterVisitChange();
  }
  if (card && !t.closest('button, a')) openDetail(card.dataset.id!);
});
panel.addEventListener('keydown', (e) => {
  const card = (e.target as HTMLElement).closest<HTMLElement>('.card[data-id]');
  if (card && (e.key === 'Enter' || e.key === ' ') && e.target === card) {
    e.preventDefault();
    openDetail(card.dataset.id!);
  }
});
panel.addEventListener('change', (e) => {
  const t = e.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  if (t.id === 'minRating') {
    store.filters.minRating = +t.value;
    store.saveFilters();
    // Lagere drempel dan waarmee we bij Google zochten? Dan opnieuw zoeken.
    if (S.source === 'google' && store.filters.minRating < S.searchedMinRating && S.center) return runSearch(S.center, { fly: false });
    renderFilters();
    return refresh();
  }
  if (t.id === 'cuisine') {
    store.filters.cuisine = t.value;
    return refresh();
  }
  if (t.id === 'sort') {
    store.filters.sort = t.value as SortMode;
    store.saveFilters();
    return refresh();
  }
  if (t.id === 'radius') return setRadius(+t.value, true);
  if (t.id === 'visitDate' && S.selected) {
    const r = findRestaurant(S.selected);
    if (r) store.updateVisit(r, { visitedOn: t.value || undefined });
  }
  if (t.id === 'visitNote' && S.selected) {
    const r = findRestaurant(S.selected);
    if (r) store.updateVisit(r, { note: t.value.trim() || undefined });
  }
});
panel.addEventListener('input', (e) => {
  const t = e.target as HTMLInputElement;
  if (t.id === 'radius') {
    store.filters.radius = +t.value;
    $('#radiusOut').textContent = formatDistance(+t.value);
    map.setRadius(+t.value);
    if (+t.value <= S.searchedRadius) refresh();
  }
  if (t.id === 'listQuery') {
    store.filters.query = t.value;
    refresh();
  }
});

let radiusTimer: number | undefined;
function setRadius(r: number, commit: boolean) {
  store.filters.radius = r;
  store.saveFilters();
  map.setRadius(r);
  const out = document.getElementById('radiusOut');
  if (out) out.textContent = formatDistance(r);
  const slider = document.getElementById('radius') as HTMLInputElement | null;
  if (slider) slider.value = String(r);
  if (!commit || !S.center) return;
  updateUrl();
  clearTimeout(radiusTimer);
  if (r > S.searchedRadius) {
    radiusTimer = window.setTimeout(() => S.center && runSearch(S.center), 250);
  } else {
    refresh();
    renderFilters();
    map.fitRadiusInset(sheet.coveredPx());
  }
}

// Tabs
$$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab as State['tab'])));
$('#surpriseBtn').addEventListener('click', surprise);
$('#recenterBtn').addEventListener('click', () => map.fitRadiusInset(sheet.coveredPx()));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#pane-detail').hidden && !($('#settingsDialog') as HTMLDialogElement).open) closeDetail();
  if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
    e.preventDefault();
    input.focus();
  }
});

// ---------- Instellingen ----------
const dlg = $('#settingsDialog') as HTMLDialogElement;
const keyInput = $('#keyInput') as HTMLInputElement;
function openSettings() {
  const s = store.settings;
  $$<HTMLInputElement>('input[name="source"]', dlg).forEach((r) => (r.checked = r.value === s.source));
  keyInput.value = s.googleKey;
  ($('#themeSelect') as HTMLSelectElement).value = s.theme;
  ($('#windowSelect') as HTMLSelectElement).value = String(s.newWindowDays);
  $('#keyStatus').textContent = s.googleKey ? 'Sleutel opgeslagen op dit apparaat.' : '';
  $('#apiUsage').textContent = apiCalls ? `Google-aanvragen deze sessie: ${apiCalls}` : '';
  dlg.showModal();
}
$('#settingsBtn').addEventListener('click', openSettings);
$('#toggleKey').addEventListener('click', () => {
  keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
  $('#toggleKey').textContent = keyInput.type === 'password' ? 'Toon' : 'Verberg';
});
$('#testKey').addEventListener('click', async () => {
  const key = keyInput.value.trim();
  const st = $('#keyStatus');
  if (!key) {
    st.textContent = 'Vul eerst een sleutel in.';
    return;
  }
  st.textContent = 'Testen…';
  try {
    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'places.id' },
      body: JSON.stringify({ textQuery: 'restaurant Amsterdam', pageSize: 1 }),
    });
    apiCalls++;
    if (res.ok) st.innerHTML = '✅ Werkt! Sla op en zoek opnieuw.';
    else {
      const j = await res.json().catch(() => null);
      st.textContent = `❌ ${j?.error?.message ?? `Fout ${res.status}`}`;
    }
  } catch (e) {
    st.textContent = `❌ Geen verbinding met Google (${(e as Error).message})`;
  }
});
$('#settingsForm').addEventListener('submit', (e) => {
  const submitter = (e as SubmitEvent).submitter as HTMLButtonElement | null;
  if (submitter?.value !== 'save') return;
  const s = store.settings;
  const prevSource = effectiveSource();
  const prevWindow = s.newWindowDays;
  s.source = ($$<HTMLInputElement>('input[name="source"]:checked', dlg)[0]?.value ?? 'auto') as typeof s.source;
  s.googleKey = keyInput.value.trim();
  s.theme = ($('#themeSelect') as HTMLSelectElement).value as typeof s.theme;
  s.newWindowDays = +($('#windowSelect') as HTMLSelectElement).value;
  if (s.source === 'google' && !s.googleKey) toast('Zonder sleutel gebruiken we OpenStreetMap.');
  store.saveSettings();
  applyTheme();
  if (S.center && (prevSource !== effectiveSource() || prevWindow !== s.newWindowDays || S.source !== effectiveSource())) {
    cache.clear();
    runSearch(S.center, { fly: false });
  }
});
$('#exportBtn').addEventListener('click', () => {
  const blob = new Blob([store.exportJson()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `smaakradar-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$('#importInput').addEventListener('change', async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  try {
    const n = store.importJson(await f.text());
    toast(`✅ ${n} restaurant${n === 1 ? '' : 's'} teruggezet`);
    afterVisitChange();
  } catch (err) {
    toast(`❌ ${(err as Error).message}`);
  }
  (e.target as HTMLInputElement).value = '';
});
$('#resetBtn').addEventListener('click', () => {
  if (!confirm('Weet je het zeker? Je afvinklijst, verlanglijst en notities worden gewist.')) return;
  store.clearAll();
  afterVisitChange();
  toast('Alles gewist');
});

// ---------- Opstarten ----------
store.onVisits(() => {
  /* opslag gebeurt in de store; UI wordt per actie bijgewerkt */
});
renderMineCount();
const params = new URLSearchParams(location.search);
const fromUrl: SearchCenter | null =
  params.get('lat') && params.get('lng')
    ? { lat: +params.get('lat')!, lng: +params.get('lng')!, label: params.get('q') ?? 'Gedeelde locatie' }
    : null;
if (params.get('r')) store.filters.radius = Math.max(300, Math.min(5000, +params.get('r')! || 1500));
if (params.get('demo') !== null) store.settings.source = 'demo';
const start = fromUrl ?? store.last;
renderDiscover();
if (start) runSearch(start);
else map.map.setView([52.2, 5.3], 7); // Nederland

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
