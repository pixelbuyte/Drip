import { SCENES, type Category } from './products';

const TILES: { label: string; glyph: string; category: Category; tilt: number }[] = [
  { label: 'Sneakers', glyph: '👟', category: 'sneakers', tilt: -6 },
  { label: 'Fashion',  glyph: '👗', category: 'fashion',  tilt: 5 },
  { label: 'Beauty',   glyph: '💄', category: 'beauty',   tilt: -4 },
  { label: 'Gaming',   glyph: '🎮', category: 'gaming',   tilt: 7 },
  { label: 'Tech',     glyph: '📱', category: 'tech',     tilt: -5 },
  { label: 'Home',     glyph: '🏠', category: 'home',     tilt: 4 },
  { label: 'Fitness',  glyph: '🏋️', category: 'fitness', tilt: -7 },
  { label: 'Gifts',    glyph: '🎁', category: 'gifts',    tilt: 6 },
];

export default function CategoryTiles() {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
      {TILES.map((t, i) => {
        const scene = SCENES[t.category];
        return (
          <a
            key={t.label}
            href="#feed"
            data-enter="rise"
            className="group relative block overflow-hidden rounded-tile shadow-card transition-shadow duration-300 hover:shadow-card-hover"
            style={{ '--i': i % 4 } as React.CSSProperties}
          >
            <div
              className="art aspect-[5/4] w-full"
              style={{ background: `linear-gradient(135deg, ${scene.from}, ${scene.to})`, containerType: 'inline-size' }}
            >
              <span
                className="absolute left-1/2 top-[48%] select-none transition-transform duration-300 ease-out group-hover:scale-105"
                style={{
                  fontSize: '38cqw',
                  transform: `translate(-50%,-50%) rotate(${t.tilt}deg)`,
                  filter: `drop-shadow(0 14px 16px ${scene.shadow})`,
                  lineHeight: 1,
                }}
                aria-hidden
              >
                {t.glyph}
              </span>
            </div>
            <div className="absolute inset-x-0 bottom-0 flex items-center justify-between p-4">
              <span className="rounded-full bg-white/90 px-3 py-1 text-[15px] font-bold text-ink">{t.label}</span>
              <span className="hidden translate-y-1 text-[13px] font-bold text-coral-deep opacity-0 transition-all duration-200 group-hover:translate-y-0 group-hover:opacity-100 md:inline">
                Shop →
              </span>
            </div>
          </a>
        );
      })}
    </div>
  );
}
