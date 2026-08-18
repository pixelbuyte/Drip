import { byId, SCENES } from './products';

// One depicted app-UI card. Activity numbers and the 🔥 live ONLY in here —
// they describe the interface, never the platform.

function Thumb({ id }: { id: string }) {
  const p = byId(id);
  const scene = SCENES[p.category];
  return (
    <div
      className="art relative h-14 w-14 shrink-0 overflow-hidden rounded-[10px]"
      style={{ background: `linear-gradient(135deg, ${scene.from}, ${scene.to})`, containerType: 'inline-size' }}
    >
      <span
        className="absolute left-1/2 top-[54%] select-none"
        style={{
          fontSize: '52cqw',
          transform: `translate(-50%,-50%) rotate(${p.tilt}deg)`,
          filter: `drop-shadow(0 6px 8px ${scene.shadow})`,
          lineHeight: 1,
        }}
        aria-hidden
      >
        {p.glyph}
      </span>
    </div>
  );
}

export default function ShoppingList() {
  return (
    <div data-enter="lift" className="rounded-mock bg-card p-4 shadow-card md:p-5">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
            <path
              d="M12 21C12 21 4 15.5 4 9.8C4 6.6 6.4 4.5 9 4.5C10.3 4.5 11.4 5.1 12 6C12.6 5.1 13.7 4.5 15 4.5C17.6 4.5 20 6.6 20 9.8C20 15.5 12 21 12 21Z"
              fill="var(--color-pink)"
            />
          </svg>
          <span className="text-[15px] font-bold text-ink">My list · Fall refresh</span>
        </div>
        <span className="text-[13px] font-semibold text-muted">8 saved</span>
      </header>

      <ul className="mt-4 space-y-3">
        <li className="flex items-center gap-3">
          <Thumb id="pebble" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-semibold text-ink">Pebble Buds Mini — Matte Clay</div>
            <div className="mt-0.5 flex items-center gap-2">
              <span className="rounded-full bg-coral/10 px-2 py-0.5 text-[12px] font-bold text-coral-deep">🔥 Price drop</span>
              <span data-num className="text-[13px] text-muted line-through">$79</span>
              <span data-num className="text-[15px] font-extrabold text-sale">$59</span>
            </div>
            <div className="mt-0.5 text-[13px] text-muted">12 people bought this today</div>
          </div>
        </li>

        <li className="flex items-center gap-3 border-t border-hairline pt-3">
          <Thumb id="crescent" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-semibold text-ink">Crescent Crossbody — Butter</div>
            <div className="mt-0.5 flex items-center gap-2">
              <span className="flex items-center gap-1.5 rounded-full border border-hairline-strong px-2 py-0.5 text-[12px] font-semibold text-ink">
                <span className="anim-dot h-1.5 w-1.5 rounded-full bg-cobalt" /> Back in stock
              </span>
              <span data-num className="text-[15px] font-extrabold text-ink">$72</span>
            </div>
            <div className="mt-0.5 text-[13px] text-muted">It’s back. You know what to do.</div>
          </div>
        </li>

        <li className="flex items-center gap-3 border-t border-hairline pt-3">
          <Thumb id="gripwell" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-semibold text-ink">Gripwell Studio Mat — Sage</div>
            <div className="mt-0.5 flex items-center gap-2">
              <span className="text-[12px] font-medium text-muted">Watching price</span>
              <span data-num className="text-[15px] font-extrabold text-ink">$48</span>
            </div>
          </div>
        </li>
      </ul>

      <button
        type="button"
        className="mt-5 w-full rounded-full bg-coral py-3 text-[15px] font-bold text-ink shadow-cta transition-transform duration-150 active:scale-[0.97]"
      >
        Move to cart
      </button>
    </div>
  );
}
