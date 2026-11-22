import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { EnrichedRestaurant, LatLng, VisitRecord } from '../types';
import { esc, fmtRating } from './render';

const TILES = {
  light: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
  dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
};
const ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';

export class MapView {
  map: L.Map;
  private tiles: L.TileLayer;
  private layer = L.layerGroup();
  private home?: L.Marker;
  private circle?: L.Circle;
  private markers = new Map<string, L.Marker>();
  private selected?: string;
  onSelect: (id: string) => void = () => {};

  constructor(el: HTMLElement, dark: boolean) {
    this.map = L.map(el, { zoomControl: false, attributionControl: true, zoomSnap: 0.5, center: [52.37, 4.895], zoom: 13 });
    L.control.zoom({ position: 'topright' }).addTo(this.map);
    this.tiles = L.tileLayer(dark ? TILES.dark : TILES.light, { attribution: ATTR, maxZoom: 20, subdomains: 'abcd', detectRetina: false }).addTo(this.map);
    this.layer.addTo(this.map);
  }

  setDark(dark: boolean) {
    this.tiles.setUrl(dark ? TILES.dark : TILES.light);
  }

  setCenter(c: LatLng, radius: number, fly = true, bottomInset = 0) {
    const icon = L.divIcon({ className: 'home-pin', html: '<div class="home-dot"><span></span></div>', iconSize: [28, 28], iconAnchor: [14, 14] });
    if (!this.home) this.home = L.marker([c.lat, c.lng], { icon, zIndexOffset: 2000, keyboard: false, interactive: false }).addTo(this.map);
    else this.home.setLatLng([c.lat, c.lng]);
    if (!this.circle)
      this.circle = L.circle([c.lat, c.lng], { radius, className: 'radius-circle', interactive: false }).addTo(this.map);
    else {
      this.circle.setLatLng([c.lat, c.lng]);
      this.circle.setRadius(radius);
    }
    if (fly) this.fitRadiusInset(bottomInset);
  }

  setRadius(r: number) {
    this.circle?.setRadius(r);
  }

  private icon(r: EnrichedRestaurant, v?: VisitRecord, selected = false): L.DivIcon {
    const cls = ['pin'];
    if (v?.visited) cls.push('pin--visited');
    else if (r.isTop && r.rating !== undefined && r.rating >= 4.7) cls.push('pin--gold');
    else if (r.isTop) cls.push('pin--top');
    else if (r.isNew) cls.push('pin--new');
    if (r.isNew && !v?.visited) cls.push('has-new');
    if (v?.wishlist) cls.push('has-wish');
    if (selected) cls.push('is-selected');
    const label = v?.visited ? '✓' : r.rating !== undefined ? fmtRating(r.rating) : (r.cuisineEmoji ?? '🍽️');
    return L.divIcon({
      className: 'pin-wrap',
      html: `<div class="${cls.join(' ')}"><span class="pin-label">${esc(label)}</span>${r.isNew && !v?.visited ? '<i class="pin-new">NIEUW</i>' : ''}${v?.wishlist ? '<i class="pin-heart">♥</i>' : ''}</div>`,
      iconSize: [38, 46],
      iconAnchor: [19, 44],
      tooltipAnchor: [0, -40],
    });
  }

  render(list: EnrichedRestaurant[], visits: Record<string, VisitRecord>, extra: VisitRecord[] = []) {
    const keep = new Set<string>();
    for (const r of list) {
      keep.add(r.id);
      const icon = this.icon(r, visits[r.id], r.id === this.selected);
      let m = this.markers.get(r.id);
      if (!m) {
        m = L.marker([r.location.lat, r.location.lng], { icon, riseOnHover: true, title: r.name, alt: r.name });
        m.on('click', () => this.onSelect(r.id));
        m.bindTooltip(esc(r.name), { direction: 'top', className: 'pin-tip' });
        m.addTo(this.layer);
        this.markers.set(r.id, m);
      } else {
        m.setIcon(icon);
      }
      m.setZIndexOffset(r.id === this.selected ? 1000 : r.isTop ? Math.round((r.rating ?? 0) * 50) : 0);
    }
    // Bezochte/verlanglijst-zaken die niet in de huidige resultaten zitten: klein stipje
    for (const v of extra) {
      if (keep.has(v.id)) continue;
      keep.add(v.id);
      const html = `<div class="mini-pin ${v.visited ? 'is-visited' : 'is-wish'}">${v.visited ? '✓' : '♥'}</div>`;
      const icon = L.divIcon({ className: 'pin-wrap', html, iconSize: [22, 22], iconAnchor: [11, 11] });
      let m = this.markers.get(v.id);
      if (!m) {
        m = L.marker([v.location.lat, v.location.lng], { icon, title: v.name });
        m.on('click', () => this.onSelect(v.id));
        m.bindTooltip(esc(v.name), { direction: 'top', className: 'pin-tip' });
        m.addTo(this.layer);
        this.markers.set(v.id, m);
      } else m.setIcon(icon);
    }
    for (const [id, m] of this.markers) {
      if (!keep.has(id)) {
        m.remove();
        this.markers.delete(id);
      }
    }
  }

  /** bottomInset: hoeveel pixels onderin bedekt zijn door het (mobiele) paneel. */
  select(id: string | undefined, pan = true, bottomInset = 0) {
    this.selected = id;
    if (!id) return;
    const m = this.markers.get(id);
    if (m && pan) {
      const z = Math.max(this.map.getZoom(), 15);
      const p = this.map.project(m.getLatLng(), z).add([0, bottomInset / 2]);
      this.map.flyTo(this.map.unproject(p, z), z, { duration: 0.6 });
    }
  }

  /** Zoom zodat cirkel zichtbaar is boven het mobiele paneel. */
  fitRadiusInset(bottomInset: number) {
    if (this.circle)
      this.map.flyToBounds(this.circle.getBounds(), { paddingTopLeft: [20, 20], paddingBottomRight: [20, 20 + bottomInset], duration: 0.6 });
  }

  invalidate() {
    this.map.invalidateSize();
  }
}
