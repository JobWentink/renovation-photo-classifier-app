/** Klein feestje als je een restaurant afvinkt. */
export function confetti(x: number, y: number) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const c = document.createElement('canvas');
  c.className = 'confetti';
  const dpr = Math.min(2, devicePixelRatio || 1);
  c.width = innerWidth * dpr;
  c.height = innerHeight * dpr;
  document.body.appendChild(c);
  const ctx = c.getContext('2d')!;
  ctx.scale(dpr, dpr);
  const colors = ['#ff6b4a', '#ffb627', '#2ec4a6', '#7b61ff', '#ff4f8b'];
  const parts = Array.from({ length: 70 }, () => {
    const a = Math.random() * Math.PI * 2;
    const v = 3 + Math.random() * 6;
    return { x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 4, r: 3 + Math.random() * 4, c: colors[(Math.random() * colors.length) | 0], rot: Math.random() * 6, life: 1 };
  });
  let frame = 0;
  const tick = () => {
    frame++;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    let alive = 0;
    for (const p of parts) {
      p.vy += 0.25;
      p.vx *= 0.985;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += 0.2;
      p.life -= 0.012;
      if (p.life <= 0) continue;
      alive++;
      ctx.save();
      ctx.globalAlpha = Math.min(1, p.life * 1.5);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.r, -p.r / 2, p.r * 2, p.r);
      ctx.restore();
    }
    if (alive && frame < 200) requestAnimationFrame(tick);
    else c.remove();
  };
  requestAnimationFrame(tick);
}

let toastTimer: number | undefined;
export function toast(msg: string, action?: { label: string; run: () => void }) {
  const el = document.getElementById('toast')!;
  el.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = msg;
  el.appendChild(span);
  if (action) {
    const b = document.createElement('button');
    b.textContent = action.label;
    b.onclick = () => {
      action.run();
      el.classList.remove('show');
    };
    el.appendChild(b);
  }
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('show'), action ? 5000 : 3000);
}

/**
 * Mobiel: het paneel is een "bottom sheet" die je omhoog/omlaag sleept.
 * Drie standen: peek (alleen samenvatting), half, full.
 */
export type SheetState = 'peek' | 'half' | 'full';

export class Sheet {
  state: SheetState = 'half';
  onChange: (s: SheetState) => void = () => {};
  constructor(
    private panel: HTMLElement,
    handle: HTMLElement,
  ) {
    let startY = 0;
    let startT = 0;
    let dragging = false;
    let moved = false;
    const mq = matchMedia('(max-width: 820px)');
    const translateFor = (s: SheetState) => {
      const h = panel.offsetHeight;
      return s === 'full' ? 0 : s === 'half' ? h * 0.45 : h - 132;
    };
    handle.addEventListener('pointerdown', (e) => {
      if (!mq.matches || (e.target as HTMLElement).closest('button:not(.sheet-grip), a, input, select')) return;
      dragging = true;
      moved = false;
      startY = e.clientY;
      startT = translateFor(this.state);
      panel.classList.add('dragging');
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dy = e.clientY - startY;
      if (Math.abs(dy) > 4) moved = true;
      const t = Math.max(0, Math.min(panel.offsetHeight - 90, startT + dy));
      panel.style.transform = `translateY(${t}px)`;
    });
    const end = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      panel.classList.remove('dragging');
      panel.style.transform = '';
      const dy = e.clientY - startY;
      if (!moved) {
        // tik op de greep: wissel tussen peek en half
        this.set(this.state === 'peek' ? 'half' : this.state === 'half' ? 'full' : 'half');
        return;
      }
      const t = startT + dy;
      const opts: SheetState[] = ['full', 'half', 'peek'];
      const best = opts.reduce((a, b) => (Math.abs(translateFor(b) - t) < Math.abs(translateFor(a) - t) ? b : a));
      this.set(best);
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    this.set('half');
  }

  set(s: SheetState) {
    this.state = s;
    this.panel.dataset.sheet = s;
    this.onChange(s);
  }

  /** Hoeveel pixels van de kaart het paneel nu bedekt (alleen mobiel). */
  coveredPx(): number {
    if (!matchMedia('(max-width: 820px)').matches) return 0;
    const h = this.panel.offsetHeight;
    return this.state === 'full' ? h : this.state === 'half' ? h * 0.55 : 132;
  }
}
