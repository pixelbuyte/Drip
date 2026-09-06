# Landing art

Section imagery for the marketing page, derived from the four reference
visuals the founder generated for Drip. Everything here is cropped, cut out or
retouched from those originals — no third-party stock.

| File | What it is | Used by |
| --- | --- | --- |
| `hero-phone.webp` | The hero visual: an angled phone showing the app, with the founder's own handwritten annotations and coral scribbles. The logo and tagline baked into the top-left of the original were painted out so the page's own nav and headline carry them instead. | `hero.tsx` |
| `sticker-*.webp` | The six large soft-3D category cutouts (headphones, sneaker, lipstick, armchair, pot, monstera), transparent, each with its contact shadow baked in and tinted to its tile. | `categories.tsx`, `drops.tsx`, `final-cta.tsx` |
| `cat-*.webp` | The six small clean product renders from the hero comp's category row. Sharp only up to ~1.3x their intrinsic size. | `drops.tsx`, creator pick strips |
| `product-headphones-cream.webp`, `product-serum.webp` | Two product crops lifted from the phone screen in the hero comp. These are photographic crops on an opaque backdrop, not transparent cutouts, so they are mounted as framed prints rather than floated on a tile. | creator pick strips |
| `avatar-*.webp` | The four creator portraits (Maya J., Kenji T., Lena R., Dario M.), masked to circles. | `creators.tsx` |

## Retouching — read before replacing these files

Two cutouts were generated with recognisable third-party trademarks on them.
Both marks were painted out before the art shipped, because the page is public
marketing material:

- **`sticker-sneaker.webp`** — a Nike swoosh across the quarter panel. Removed
  by inpainting the surrounding cream panel over it.
- **`sticker-headphones.webp`** — a Beats lower-case "b" on the left earcup.
  Removed the same way.

The originals are still in git history (the first commit that added this
directory). If these files are ever regenerated or replaced, check the new art
for marks again — image generators reproduce them readily, and the silhouettes
here remain close to real products even without the logos. That closeness is a
judgement call the founder should make before launch; it is not something the
retouching resolves.
