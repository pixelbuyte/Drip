# DRIP — complete product design reference

**39 app frames · 14 design boards · 3 visual directions · 59 PDF pages**

The final design combines premium editorial imagery, tactile creator commerce and contextual product sheets. This is the static visual and behavioral reference for implementation.

Open [index.html](index.html) locally after downloading the folder to browse individual frames, switch to complete boards and search for a screen. GitHub displays the HTML source; the linked JPEG boards can be viewed directly on GitHub. The accompanying **Drip-Product-Design.pdf** is supplied in the conversation with each app frame on its own page.

- [Product, interaction and motion specification](SPECIFICATION.md)
- [Exact design tokens and contrast checks](tokens.json)
- [Frame and board manifest](manifest.json)
- [Component language: five product cards and three navigation studies](boards/14-component-language.jpg)

## Full screen index

| Frame | Screen / state | Board | PDF page |
| --- | --- | --- | --- |
| 01 | For you | [01](boards/01-feed-product-interactions.jpg) | 8 |
| 02 | Product peek | [01](boards/01-feed-product-interactions.jpg) | 9 |
| 03 | Shop the frame | [01](boards/01-feed-product-interactions.jpg) | 10 |
| 04 | Comments / 25% | [02](boards/02-comments.jpg) | 12 |
| 05 | Comments / 60% | [02](boards/02-comments.jpg) | 13 |
| 06 | Comments / 90% | [02](boards/02-comments.jpg) | 14 |
| 07 | Shop / Daily drop | [03](boards/03-shop.jpg) | 16 |
| 08 | Shop / The edit | [03](boards/03-shop.jpg) | 17 |
| 09 | Shop / Creator picks | [03](boards/03-shop.jpg) | 18 |
| 10 | Discover | [04](boards/04-discover-category-search.jpg) | 20 |
| 11 | Fashion | [04](boards/04-discover-category-search.jpg) | 21 |
| 12 | Search results | [04](boards/04-discover-category-search.jpg) | 22 |
| 13 | Product detail | [05](boards/05-product-detail.jpg) | 24 |
| 14 | Seen on Drip | [05](boards/05-product-detail.jpg) | 25 |
| 15 | Sizes and reviews | [05](boards/05-product-detail.jpg) | 26 |
| 16 | Creator storefront | [06](boards/06-creators-following-profile.jpg) | 28 |
| 17 | Following | [06](boards/06-creators-following-profile.jpg) | 29 |
| 18 | Your profile | [06](boards/06-creators-following-profile.jpg) | 30 |
| 19 | Saved | [07](boards/07-saved-notifications-bag.jpg) | 32 |
| 20 | Notifications | [07](boards/07-saved-notifications-bag.jpg) | 33 |
| 21 | Shopping bag | [07](boards/07-saved-notifications-bag.jpg) | 34 |
| 22 | Quick checkout | [08](boards/08-checkout.jpg) | 36 |
| 23 | Delivery details | [08](boards/08-checkout.jpg) | 37 |
| 24 | It's yours | [08](boards/08-checkout.jpg) | 38 |
| 25 | Compare in the feed | [09](boards/09-feed-variations.jpg) | 40 |
| 26 | Collection carousel | [09](boards/09-feed-variations.jpg) | 41 |
| 27 | Creator mini-review | [09](boards/09-feed-variations.jpg) | 42 |
| 28 | New drop announcement | [10](boards/10-drop-create-save.jpg) | 44 |
| 29 | Create a drop | [10](boards/10-drop-create-save.jpg) | 45 |
| 30 | Save to a collection | [10](boards/10-drop-create-save.jpg) | 46 |
| 31 | Shop loading | [11](boards/11-loading-empty-offline.jpg) | 48 |
| 32 | Saved / empty | [11](boards/11-loading-empty-offline.jpg) | 49 |
| 33 | Feed / connection error | [11](boards/11-loading-empty-offline.jpg) | 50 |
| 34 | Payment declined | [12](boards/12-checkout-search-recovery.jpg) | 52 |
| 35 | Variant unavailable | [12](boards/12-checkout-search-recovery.jpg) | 53 |
| 36 | Search / no matches | [12](boards/12-checkout-search-recovery.jpg) | 54 |
| 37 | Double-tap like | [13](boards/13-like-follow-scrub.jpg) | 56 |
| 38 | Follow and mini-profile | [13](boards/13-like-follow-scrub.jpg) | 57 |
| 39 | Product scrub | [13](boards/13-like-follow-scrub.jpg) | 58 |

## Starting directions

- [A — Editorial Commerce](directions/a-editorial-commerce.png)
- [B — Playful Creator Commerce](directions/b-playful-creator-commerce.png)
- [C — Future Social Shopping](directions/c-future-social-shopping.png)

## Scope and handoff

The artwork covers Home and five feed layouts, product peek, Shop the frame, comment detents, three Shop compositions, Discover, category, Search, product detail, Seen on Drip, creator storefront, Following, Saved, notifications, bag, checkout, profile, creation, social micro-interactions and recovery states. The specification adds exact navigation, eight distinctive interactions, accessibility, responsive behavior and motion contracts.

All creators, products, prices, reviews and orders in the artwork are illustrative. Follow the correction table in SPECIFICATION.md where generated artwork drifts from exact data, labels or accessibility requirements. These are static mockups, not implemented social mutations, payments or animated interactions.

Only `docs/product-design/` is part of this design change. Production application behavior is unchanged.

## Rebuild the reference gallery

Run `python3 docs/product-design/build_gallery.py`. The generator uses Python's standard library and local artwork; no build server or external fonts are required. Frame views use source-image coordinates from the PDF so the underlying image pixels remain intact.
