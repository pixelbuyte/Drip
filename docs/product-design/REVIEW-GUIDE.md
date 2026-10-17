# DRIP / implementation review guide

## What is delivered

42 full-screen raster references, 15 design boards, three starting directions, exact tokens, motion/gesture specifications, nine guided click-throughs, and a 64-page design book. The original 39 frames are retained; frames 40-42 refine the central shopping journey. The gallery is an interactive reference viewer, not the production app.

## Start here

Open `index.html` or run `npm run dev` from this folder. Choose **Walk the flows**, then **Watch it. Want it. Own it.** Inspect the refined shelf, shade selection, checkout, and return state. Frame controls support mouse, keyboard, and touch; Escape dismisses the inspector and restores focus. Arrow keys move through the current flow. `#frame=40` opens a particular reference.

Filter the screen atlas by surface or search its descriptions. Each screen opens by itself with its interaction contract. Export this frame generates a native-resolution PNG when served over HTTP. If a browser prevents canvas export from a local file, use the individual PNGs in the downloadable package or open its source board.

## Final visual selection

A supplies editorial photography and restraint. B supplies dimensional category objects, creator relevance and tactile shopping modules. C supplies contextual sheets and continuity. Use the labeled cream navigation from the component board. The final refinement replaces the tall social rail with a compact row immediately above the living shelf.

Frames 40-42 are the preferred feed, product peek and quick checkout visual references. Original screens remain useful for alternate compositions and state coverage. The current production app still needs implementation work to match these references.

## Changes in the refinement

- Social actions form one horizontal row. The creator and product remain the focal points.
- A second shelf affordance opens the three tagged products in the look. In implementation its preview should show tote, knit and denim; the coffee cup shown in the generated study is set dressing, not a tagged fourth product.
- Product name, selected color and $78 price remain consistent through peek and checkout.
- Coral purchase actions use ink text. Normal white text on this coral is not the final rule.
- The checkout shows the full illustrative $84.24 total, with delivery and payment edits before purchase.
- Blocking sheets cover bottom navigation. Any remaining visible header is inert until the modal closes.

## Exact geometry and accessibility

The raster studies guide hierarchy, not point-perfect implementation. Compose the actual app at 390 x 844 logical points with 16-20 point horizontal insets. Test 375 x 667, Android keyboard/safe-area behavior and tablet context panels. Artwork text is not accessible UI: production uses real text, semantic buttons, labeled icons and supported text scaling.

Use at least 44 x 44 point hit targets, preferably 48. The social row must give each action its own nonoverlapping target. Keep brand logo decoration out of the accessibility tree. Verify text against real bright and dark footage; solid-palette contrast checks do not certify text over media.

At large text sizes, move the editorial caption out of the media and allow a full-height peek. Comments grow vertically; the composer remains above the keyboard. Reduce motion to instant changes or <=100ms fades. Do not treat a click-through swap as proof of animation or gesture behavior.

## Important production integration gap

The existing `src/components/feed/feed-shell.tsx` contains playback suspension for open sheets. Product peek in this design keeps media playing. Implement a deliberate sheet policy: peek/comments keep the active source visible and playing when appropriate; checkout, external payment authentication, app backgrounding and user pause can suspend it. Retain the established registry and event semantics. The design branch does not modify this production logic.

The global CSS currently uses Bricolage/Hanken while the product design specifies an editorial serif/sans pairing. Scope any future typography migration to the product UI and bundle licensed fonts. Do not accidentally restyle existing business or onboarding flows.

## Nine review flows

| Flow | Frames | Review purpose |
| --- | --- | --- |
| Watch it. Want it. Own it. | 40, 41, 42, 24, 40 | Feed continuity through buying |
| A conversation, in context | 1, 4, 5, 6, 1 | All comment detents |
| From curious to convinced | 10, 11, 12, 13, 14, 15 | Discovery to product evidence |
| The shop has a rhythm | 7, 8, 9, 13, 2, 22 | Editorial and creator modules |
| Follow the taste you trust | 1, 38, 16, 17, 30, 19 | Creator and collecting paths |
| Make the next step obvious | 42, 34, 35, 33, 1 | Illustrative recovery-state review |
| Your corner of Drip | 18, 20, 19, 21, 23, 22 | Personal shopping utilities |
| One feed. Different stories | 1, 25, 26, 27, 28, 29 | Five post formats and creation |
| The spaces between | 31, 32, 36, 33, 34, 35 | Distinguish loading, empty and failure |

The recovery and state flows are review sequences, not a claim that those independent errors occur in a single real transaction.

## Hand-off truth

All people, reviews, products, prices and orders are illustrative. Real implementations must verify inventory, ownership claims, commissions, tax and shipping. Wallet artwork is a visual cue; integrate the approved platform button when available. A successful-looking reference image does not charge a card or confirm an order.

The click-through gallery, search, category filtering, frame inspector, detent links, keyboard navigation and HTTP canvas export are implemented locally. Video playback, comments, follow/save persistence, native gesture physics, auth, checkout and commerce backends are specification work for the production app.
