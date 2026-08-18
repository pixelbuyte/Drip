import { byId, CREATORS, SCENES } from './products';

export default function Creators() {
  return (
    <div data-enter="rise" className="rail -mx-5 px-5 md:-mx-6 md:px-6">
      {CREATORS.map((c) => (
        <article
          key={c.handle}
          className="w-[78vw] rounded-mock bg-card p-4 shadow-card md:w-[380px]"
        >
          <header className="flex items-center gap-3">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-violet/10 text-[13px] font-bold text-violet ring-2 ring-violet">
              {c.initials}
            </span>
            <div className="min-w-0">
              <div className="truncate text-[16px] font-bold text-ink">{c.name}</div>
              <div className="text-[13px] text-muted">{c.handle}</div>
            </div>
            <button
              type="button"
              className="ml-auto shrink-0 rounded-full bg-violet px-4 py-1.5 text-[13px] font-bold text-white transition-transform duration-150 active:scale-[0.96]"
            >
              Follow
            </button>
          </header>

          <p className="mt-3 text-[14px] leading-relaxed text-muted">
            {c.bio} <span className="text-ink">“{c.quote}”</span>
          </p>

          <div className="mt-4">
            <span className="rounded-full bg-violet/10 px-3 py-1 text-[12px] font-bold text-violet">
              Curated by {c.name}
            </span>
            <div className="mt-3 grid grid-cols-3 gap-2">
              {c.picks.map((id) => {
                const p = byId(id);
                const scene = SCENES[p.category];
                return (
                  <div key={id} className="rounded-[14px] bg-cream p-1">
                    <div
                      className="art relative aspect-square w-full overflow-hidden rounded-[10px]"
                      style={{ background: `linear-gradient(135deg, ${scene.from}, ${scene.to})`, containerType: 'inline-size' }}
                    >
                      <span
                        className="absolute left-1/2 top-[54%] select-none"
                        style={{
                          fontSize: '48cqw',
                          transform: `translate(-50%,-50%) rotate(${p.tilt}deg)`,
                          filter: `drop-shadow(0 8px 10px ${scene.shadow})`,
                          lineHeight: 1,
                        }}
                        aria-hidden
                      >
                        {p.glyph}
                      </span>
                    </div>
                    <div className="px-1 py-1.5">
                      <div className="truncate text-[12px] font-medium text-ink">{p.name.split(' — ')[0]}</div>
                      <div data-num className="text-[14px] font-extrabold text-ink">${p.price}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <button
            type="button"
            className="mt-4 w-full rounded-full border border-hairline-strong bg-card py-2.5 text-[14px] font-bold text-ink transition-colors duration-150 hover:border-violet/40 hover:text-violet"
          >
            Shop their picks
          </button>
        </article>
      ))}
    </div>
  );
}
