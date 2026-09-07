# DRIP — product experience specification

This is the implementation companion to the 39 frame visual reference set. The boards are static mockups. Gestures, motion, checkout and social persistence described here are contracts for implementation; the images do not execute them. All creators, products, prices, reviews, social counts and orders in the artwork are illustrative.

## Selected direction

**The feed is the store. The people make it Drip.**

Editorial Commerce supplies the large photography, expressive headings and quiet cream surfaces. Playful Creator Commerce supplies the dimensional category objects, tactile product shelf and occasional coral or lime punctuation. Future Social Shopping supplies contextual sheets and the continuity from video to product to purchase.

The resulting language is warm and recognizable: an editorial headline over a creator story, an inviting cream product shelf, an ink and coral action, then a sheet that grows from the object being inspected. There is one clear purchase path and a persistent sense of who recommended the item.

The three original directions remain exploration references, not three themes offered inside the app.

## Artwork corrections: exact rules take precedence

Generated mockups establish hierarchy, imagery and composition. Use the following rules where individual rendered labels or details drift:

| Detail | Implementation rule |
| --- | --- |
| Global header | The For you / Shop switch appears only inside Home. Other sections get their own title, search or back controls. |
| Primary coral buttons | Use ink `#201A17` text and icons on `#FF4B2E`. White normal text on this coral does not meet the target contrast. |
| Like and Save | Heart means Like. Bookmark means Save. A filled symbol and accessible pressed state accompany color changes. |
| Studio Tote | $78; Chocolate, Sand and Black; no size selector. The price remains consistent from chip through checkout. |
| Compact speaker | Use the same compact speaker model and silhouette for a SKU throughout its video, thumbnail, detail and variant views. |
| Under $50 | Only products priced below $50 belong in this module. The $78 tote does not. |
| Discounts | Only show a previous price supported by actual product data. Calculate the percentage from those values. |
| Final confirmation | The line item is $78. The order total is $84.24 in the illustrated $6.24 tax example. Label the total explicitly. |
| Shipping and tax | The artwork uses a fictional US example anchored to September 7, 2026. Production totals and delivery estimates come from the current address, shipping choice and checkout response. |
| Marketing alerts | Purchase success does not subscribe someone to recommendations. Price, restock and drop alerts require a separate choice. |
| Commerce claims | Scarcity, ownership, repurchase, review score, shipping and returns claims require real supporting records. |
| Sheet navigation | A blocking checkout covers the app navigation. Product and comment sheets retain contextual media; obscured controls cannot receive taps. |
| Device proportions | Compose at 390 × 844 logical points first. The visual boards are presentation references, not exact measured layouts. |

## Navigation architecture

| Destination | Primary content | Secondary paths |
| --- | --- | --- |
| Home | For you video feed; Shop editorial stream | Product peek, comments, creator mini profile, product detail, checkout |
| Discover | Search, trends, dimensional categories, creators | Category, search results, drops, collections |
| Drop | Create a post with a tagged product | Media selection, edit, product tagging, preview, publish |
| Following | New posts from followed creators | Creator circles, live drops, reminders, profiles |
| Profile | Personal identity and shopping history | Orders, Saved, reviews, following, preferences |

Bag and Notifications are utility destinations reached from the top bar. Saved is reachable through Profile and a save confirmation. Search has products, videos, creators and collections in one coherent results flow. Product detail can be entered from a peek or any discovery module, preserving its origin for Back.

Root tab selection preserves each tab's scroll position. Selecting the active Home tab scrolls to the current feed start only after an explicit second tap; it does not silently refresh content. Drop opens a creation flow over the prior destination rather than discarding that destination.

### Navigation studies and final choice

The component board explores a labeled cream dock, a compact floating capsule and a media-oriented translucent dock. Choose the **labeled cream dock** for the final system: five equal interaction zones, a coral circular Drop action, ink filled selected icon, a small coral indicator and a visible label. Keep the selected label semibold. A full-width cream surface and subtle top divider maintain readability over media.

Navigation content height is 64 points plus the device bottom safe area. The center circle is 48 points inside a minimum 56-point hit zone. Labels are 12–13 points with sufficient contrast; the label and icon are one accessible control. Do not rely on the small selected dot alone. Icon geometry should use a coherent 24-point grid with 2-point optical strokes, rounded caps and clearly distinct silhouettes. Select one licensed icon family for implementation, then make the shopping bag and Drop treatment distinctive through proportion and surrounding composition.

## Design system

### Color

| Token | Hex | Use |
| --- | --- | --- |
| cream | `#FFF9F2` | App canvas, sheets and navigation |
| ink | `#201A17` | Primary text, buttons, selected state |
| muted | `#6E6259` | Secondary readable text on cream |
| coral | `#FF4B2E` | Main purchase action, Drop and small brand punctuation |
| coralText | `#C2410C` | Text links and accent text on cream |
| lime | `#C7F03C` | New drop or fresh content badge, with ink text |
| lavender | `#E9DDFC` | Selected editorial/category backgrounds |
| pink | `#FADDE5` | Beauty/editorial accents |
| peach | `#FFE0CC` | Warm objects and sale surfaces |
| mint | `#DCEADB` | Home/wellness accents and positive surfaces |
| saleText | `#B52E18` | Discount text on peach |
| successText | `#245534` | Positive text on mint |

Measured normal text ratios: ink/cream 16.44:1; muted/cream 5.65:1; ink/coral 5.16:1; coralText/cream 4.95:1; ink/lime 13.06:1; saleText/peach 4.98:1; successText/mint 6.95:1. Treat translucent media contexts separately: these flat palette measurements do not certify text over photographs.

### Typography

Use a refined editorial serif such as Instrument Serif for display and a neutral sans such as DM Sans for all product information and controls. The exact fonts require licensed, bundled assets; system serif/sans are acceptable prototype fallbacks, not the visual target.

| Role | Size / line height | Notes |
| --- | --- | --- |
| Hero display | 40–48 / 42–50 | At most two lines; avoid covering a face or product |
| Screen title | 30–34 / 34–38 | Serif where editorial; sans for utility screens |
| Section title | 22–24 / 28 | Mostly serif; no gratuitous uppercase |
| Product title | 18 / 24 | Sans semibold; up to two lines |
| Body / input | 16 / 22–24 | Default readable interaction text |
| Compact metadata | 14 / 18–20 | Price context, shipping, creator attribution |
| Navigation | 12–13 / 16 | Always paired with clear icons |

Prices use tabular figures where values are aligned, such as a bag or order summary. Old prices are secondary and struck through; current prices remain primary. Buttons retain full, meaningful labels.

### Layout, radius and elevation

Spacing scale: 4, 8, 12, 16, 20, 24, 32, 40 and 48 points. Standard horizontal inset is 20; compact phones use 16. Related information is separated by 8–12; sections by 24–32. Reserve the bottom safe area independently from content padding.

Radius: 8 for thumbnails and small objects; 12 for fields; 16 for product tiles; 24 for media frames and product shelves; 28 for sheet tops; fully rounded only for chips, avatars and circular actions. Avoid rounding every nested row.

Elevation: card `0 4px 16px rgba(32,26,23,.06)`; floating shelf `0 8px 28px rgba(32,26,23,.12)`; sheet `0 -8px 32px rgba(32,26,23,.14)`. Use dividers before adding shadows. Media caption scrims are short, directional and chosen for readable contrast; glass is limited to useful media controls.

### Buttons, chips and creator components

Primary purchase: coral with ink label, 52-point height, 16-point semibold. Secondary: cream with ink border. Destructive choices use clear wording and separate placement. Disabled controls retain an explanatory label and sufficient readability; they are not merely faded away.

Filter chips: minimum 40-point visual height within 44-point hit areas, label plus optional count; selected state uses fill and a check where needed. Color choices show a readable name and check, not a swatch alone. Avatars use 32, 40, 56 or 88 points depending on context. Creator rows group avatar, name, verification and follow state, with commission disclosure near the product purchase context.

### Five product-card variants

| Variant | Layout and essential content | Primary use |
| --- | --- | --- |
| Compact feed shelf | 56-point product thumbnail, title, price and selected color; Shop action | Persistent lower media edge |
| Discovery tile | Product photograph, two-line name, price; optional rating or creator cue | Horizontal product strip |
| Editorial feature | Large photograph, expressive collection heading, creator and clear shop action | Shop lead story / daily drop |
| Sale card | Price and previous price, explicit savings; warm accent surface; optional save | Price drops module |
| Creator recommendation | Creator portrait/video crop with product inset, name and price | Creator picks / social proof |

Never show rating, scarcity, discount, creator badge, shipping, every variant and both cart controls on one compact tile. The peek progressively reveals buying information.

## Home and scrolling

The active post occupies the available area between the Home header and bottom navigation. Use vertical snap scrolling with one active post. Position the creator and caption toward the lower left, a social rail within thumb reach on the right, and a cream product shelf above the navigation. Protect the main subject from overlays through an editorial safe region.

Feed layouts deliberately alternate:

1. Full creator video: image dominates, with concise creator/caption and shelf.
2. Comparison: the creator's demonstration plus two clearly labeled product options.
3. Collection: horizontal product carousel inside one vertically snapped post; gesture direction locks after initial intent.
4. Mini review: short verdict, supported criteria and the associated product.
5. Drop announcement: one product story, clear release time and an opt-in reminder.

The feed does not pretend every post is breaking news. Limit status badges to actual distinctions. Creator disclosure belongs near the shopping context and remains available after UI collapse.

### Scroll and media contract

| Trigger | Result |
| --- | --- |
| User starts vertical scroll | Collapse expanded captions, end scrub previews, cancel uncommitted peeks; dim secondary chrome to 70% during movement |
| Post snaps and becomes active | Restore controls within 120ms; play only the active video; show concise caption immediately |
| Active post settles | Preload the next video's metadata and poster; opportunistically buffer one next item according to connection/data saver |
| Single tap on media | Pause or resume, with a briefly visible state icon and an accessible control |
| Double tap within 280ms | Like once; cancel the pending single-tap action and animate a small local heart |
| Long press on untagged media | Pause while held and open a small actions menu; cancel if a scroll wins the gesture |
| Tap caption | Expand to readable text; explicit Less control returns it to two lines |
| Product shelf opens | Suspend feed scrolling and preserve the current post and video playhead |
| Leave the tab / app backgrounds | Pause video and release unnecessary decoding work |
| Return to feed | Restore the previous post, playhead, mute choice and selected variant |

Start muted unless the user has explicitly chosen sound for the session. Sound toggle is persistent and labeled. Sound never starts because the user opened a product. Respect system interruption and data saver. Provide captions independently of mute, and expose play/pause for keyboard and screen reader users. A thin progress indicator is optional when useful to judge clip length; avoid a bright competing timeline.

## Product peek and shopping continuity

The compact shelf grows into a cream sheet aligned to the original product thumbnail. Expand to roughly 65% of usable height, preserving a recognizable portion of the source video. This is the signature transition: the product has depth without abandoning the story.

Expanded content: swipeable product imagery; title; price and supported previous price; review count; color; sizes only where applicable; delivery estimate; return summary; creator commission disclosure; Full details and Buy now. A close button and handle offer alternatives to dragging. Selecting imagery does not silently commit a new variant; label each color selection explicitly.

Full details opens a product screen with imagery, rating/reviews, variant selection and a sticky Buy now / Add to bag bar. Continue down to the recommending creator, their video, **Seen on Drip** creator videos for the same product, and related items. Back restores the source peek and media position.

### Eight distinctive Drip interactions

| Interaction | Entry and behavior | Accessible alternative |
| --- | --- | --- |
| Product scrub | Hold a shelf for 350ms, then slide horizontally through variant previews. Show selected color and price. Release leaves an explicit confirmation before changing a bag or checkout choice. | Open peek and choose labeled variants |
| Drop stack | Pull the shelf upward a short distance to reveal every tagged product in the post as an ordered stack. Feed scroll takes precedence when the drag begins outside the shelf. | Tap product count / Shop this look |
| Hold to peek | Hold a product tile to preview price, review count, colors and shipping. Release dismisses; no cart mutation occurs. | Tap Details |
| Shop the frame | Tap the frame action to reveal numbered tags tied to the current visible objects, plus a corresponding list. No inferred or unverified objects become buyable tags. | Read the ordered product list |
| Creator trust trail | Tap a supported claim such as Used for 8 months to see its source, date and disclosure. Hide claims without underlying evidence. | Standard labeled information button |
| Save threads | Saving connects a product to the creator/post that introduced it. A brief collection chooser offers a destination and undo; browsing Saved can return to that exact source. | Save button, collection menu and source link |
| Same-item chorus | Seen on Drip presents contrasting creator demonstrations of the same SKU. Switching clips preserves the product and variant selection. | Standard labeled video list |
| Return ribbon | After checkout, a quiet Back to your feed action returns to the exact post and playhead. An order link remains in Profile; purchase does not force a new feed. | Explicit Back to feed and View order buttons |

All gesture-only shortcuts have a visible route. No hold interaction opens checkout or makes a purchase by itself. Do not send price, ownership or trust claims generated by an AI into production without verified product data.

## Likes, follows, saves and sharing

Like updates immediately, adds one count and displays a filled heart. Double-tap always likes; it does not toggle an already-liked post off. The explicit heart toggles. Deduplicate rapid requests. A failed mutation restores the prior state and shows a concise retry message. The large animated heart is limited to about 52 points, fades within 260ms and does not obscure a face.

Follow changes to Following immediately, with a check and 180ms crossfade/width transition. Preserve button width where practical. Add the creator to Following after successful persistence; on failure restore Follow with retry feedback. Tapping the avatar or name opens the creator profile; holding can open a mini profile, with an equivalent visible profile link. The mini profile includes recent content and a clear full-profile action.

Save uses a bookmark and a brief confirmation with optional collection selection. Saving a product and saving a video are distinct data types. They can be grouped together in All without duplicating an item in Products. Save failures are recoverable and never erase an existing collection.

Share opens the platform sheet with the post/product link and useful preview. Copy link gives a small confirmation. Preserve the selected source and variant in share metadata when supported, without embedding personal delivery or payment information.

## Comments

Comments are a draggable bottom sheet with **25%, 60%, and 90%** detents of available app height. Open at 60%. At 25%, show header, pinned comment excerpt and the composer entry; at 60%, show the pinned comment and a useful list; at 90%, support reading threads and typing. Video remains visible behind the sheet where space permits.

Include handle, total count, close control, pinned badge, avatars, usernames, timestamps, comment likes, reply counts, View replies and an input anchored above the keyboard. Use 16-point body text, full wrapping and lightweight separators. Quick emoji reactions are optional, labeled controls, not the only means of replying.

Drag the handle to change detents. Inside the list, normal scrolling wins; only pull the sheet when the list is at its top and the downward gesture is clear. Keep text focus while expanding for the keyboard, cap the sheet below the top safe area, and restore the previous detent after dismissal. Screen readers get labeled Expand and Collapse actions. Escape or Android Back closes replies before closing the entire sheet.

Keep a draft when dismissing the panel. Sending adds a pending item; failures retain the text and expose Retry. Reply context names its recipient. Thread expansion preserves list position. Creator-pinned comments must come from actual pin state, not a visual badge applied to an arbitrary response.

## Discover, category, search and Shop

Discover begins with search and an editorial trend story. Categories use polished dimensional object images on restrained pastels, never generic category line icons: Electronics, Fashion, Beauty, Home, Kitchen, Wellness, Plants, Accessories and Sports. Use meaningful text labels for every object.

A category such as Fashion opens with its own hero, topical filters (Sneakers, Bags, Streetwear, Basics, Accessories), trending creator videos, top products, relevant creators, new drops and deals. Keep video and editorial modules primary; don't reduce the category to an endless uniform grid.

Search recognizes products, creators, categories, brands and trends. For white sneakers, show a useful mixed overview and tabs for Videos, Products, Creators and Collections. Filters change the results while keeping the query visible. No-result states preserve the text, suggest narrower spelling/category changes, and show Clear filters when filters caused the empty result. A network failure is labeled as a connection problem rather than falsely claiming zero results.

Shop is a stream of varied modules: Your daily drop; Trending on Drip; Under $50; Creator favorites; Price drops; New this week; Popular with people you follow; Shop by category. Alternate large editorial stories, horizontal creator clips and compact product strips. Keep one clear focal module in the first viewport. Every recommendation should have a comprehensible reason, such as From creators you follow or Because you saved bags; omit such labels when the evidence is missing.

## Creator profile, Following and personal profile

Creator profile combines identity and storefront: avatar, name, verification, follower/following counts, bio, Follow, featured drop, video grid, collections and top picks. Collections can include Under $50, Things I actually use, Summer rotation, Desk setup and Skin routine. Let content determine the categories; do not insert empty tabs.

Following has its own hierarchy: creator circles, New from creators you follow, live drops and chronological recent posts. Upcoming releases get opt-in reminders. A first-use state explains the value and offers relevant creators without pretending the user already follows them.

The personal profile stays light: avatar/username, Orders, Saved, Following, Reviews and Preferences; recent purchases; creator suggestions and favorite categories. An order opens status and tracking; it does not enter the general product checkout flow. Recommendations must not crowd account controls.

## Saved and Notifications

Saved has All, Products, Videos and Collections. Useful smart groups include Fashion, Beauty, Tech, Under $50 and Price dropped. Display a creator source when available. A price drop shows old and current price with a timestamp. Pinning or editing a collection is explicit; smart grouping never silently moves items out of the user's own collection.

Notifications emphasize useful events: a followed creator's drop, saved price drop, restock, comment reply, shipping update or opted-in live event. Use distinct object/creator imagery and action labels. Read/unread state uses more than color. Group repeat events and preserve a clear route to notification preferences. Tapping stale inventory or a cancelled drop shows its current state instead of an obsolete purchase promise.

## Bag and checkout

Bag lists the exact SKU, image, selected variant, quantity and price, plus delivery context and totals. Quantity and removal update totals, with an undo when feasible. If inventory changes, preserve the rest of the bag and explain the affected item. Avoid automatic substitution.

Buy now from the product peek opens a checkout sheet over the source video. Show item, variant, quantity, delivery estimate, address, payment selection, subtotal, shipping, tax and total. Wallet payment uses the platform's approved Apple Pay / Google Pay button and actual availability. The artwork is a visual placeholder for those native controls.

Address editing is a nested sheet with real field labels, autofill and country-aware fields. Show inline validation and preserve valid fields. A saved address must be explicitly chosen or intentionally saved; the user can edit before purchasing. Shipping options recalculate the total before payment.

Before creating a payment, revalidate price, stock, shipping and the selected variant. If any material value changes, show the revised summary for review. Prevent duplicate submissions using an idempotent request and a disabled progress state with readable feedback.

### Payment states

| State | UI behavior |
| --- | --- |
| Ready | Exact total visible; selected payment method and delivery visible |
| Processing | Keep context, block duplicate purchase, announce progress |
| Requires authentication | Present the provider's secure flow; preserve checkout state on return |
| Declined | Say the payment was declined; retain item/address and offer another method |
| Unknown / timed out | Say the payment status is being checked; query the order/payment state before allowing another charge |
| Stock unavailable | Identify the unavailable variant and offer available choices without selecting one automatically |
| Confirmed | Only after order confirmation, show It's yours, order identifier, total, delivery estimate and Back to your feed |

Success uses one precise check animation, not confetti. Post-purchase updates are separate from optional promotional alerts. Closing checkout before purchase returns to the prior product; closing after a confirmed order returns to the feed without repeating payment.

## Empty, loading and error states

The visual set includes feed skeleton loading, empty Saved, offline feed, payment declined, unavailable variant and no search results. Use stable skeleton dimensions so media and product controls do not jump. Respect reduced motion by removing shimmer. If cached feed media exists, keep it visible with a small offline label and Retry. Never discard comment drafts, bag contents or checkout fields on a transient failure.

Additional implementation states: no followed creators (Discover creators); empty bag (Explore today's drop); no notifications (You're all caught up); first collection (Save your first find); media playback failed (Retry or skip); upload failed (retain draft and retry); permission declined (explain how to choose existing media); unavailable product (back to source and related options). Clearly distinguish empty data, loading data and failed data.

## Motion system

Use short, controlled ease-out movement. Suggested standard cubic curve: `cubic-bezier(.2,.8,.2,1)`. Larger sheets use platform springs with a high damping ratio around 0.9–1.0 and no visible overshoot; tune physical spring values per platform rather than copying unrelated numeric constants.

| Interaction | Duration | Behavior |
| --- | --- | --- |
| Button press / release | 80 / 120ms | Scale to .98 then return; optional light haptic |
| Like | 260ms | Small local heart .8 → 1.05 → 1, quick fade; one count increment |
| Follow | 180ms | Label/check crossfade; restrained size transition |
| Save | 200ms | Bookmark fill and short collection confirmation |
| Product peek | 320ms | Shelf thumbnail and cream surface expand into contextual sheet |
| Comments detent | 300ms | Follow the finger; settle with controlled damping |
| Checkout sheet | 300ms | Slide upward with focus transfer; keep source video recognizable |
| Tab change | 180ms | Shallow crossfade; root tab bar stays anchored |
| Feed settling | 220–320ms | Native inertial scroll and snap; no artificial delayed lock |
| Purchase confirmation | 360ms | Draw or reveal one check; text and actions fade in |

Haptics are optional and used once per committed action, not on every animation frame. If reduced motion is enabled, remove spatial transforms, morphs, bursts, shimmer and parallax. Use immediate state changes or fades no longer than 100ms; keep every interaction's meaning intact.

## Accessibility and device behavior

Minimum touch target is 44 × 44 points; prefer 48. Enlarge invisible hit areas without overlapping adjacent controls. Label Like, Comments, Save, Share, sound, verification and image controls. Expose pressed/selected/expanded state semantically. Announce cart totals, follow/save results and purchase state without stealing focus.

Use visible focus, logical reading order and sheet focus management. Trap focus only for blocking modals, make background controls inert, and restore focus to the invoking control on dismissal. Honor Escape, Android Back and native screen reader actions. Maintain text contrast on video with a measured scrim; test across actual light and dark footage.

Text scaling must grow comment rows, buttons and sheets vertically. Avoid fixed text container heights. At large accessibility sizes, use a simpler media layout, move dense overlays into the peek, keep the composer reachable and permit full-height sheets. Product color has a name, disabled stock has a label, and selected tabs have text and shape cues.

Primary composition: 390 × 844 logical points. At 375 × 667, reduce heading scale and media caption length, preserve target sizes and move secondary content behind the peek. On Android, use the actual safe areas, back behavior, keyboard insets and wallet availability. On tablet, retain a focused media column and use a contextual product/comments column where width supports it; do not stretch a single phone UI across the whole display.

## Implementation order and review gates

1. Build the shared tokens, labeled navigation, video shell and five product component variants.
2. Complete the primary journey: feed → peek → variant → checkout → confirmation → same feed position.
3. Add social persistence, comment detents and creator mini profile, including failure rollback and draft preservation.
4. Complete Discover, Shop, product detail, categories, search and Seen on Drip.
5. Complete creator storefront, Following, Saved, Profile, notifications and creation.
6. Verify recovery paths, text scaling, reduced motion, keyboard behavior, safe areas and representative small-phone layouts.

Review the implementation beside the board for the same state and viewport. Verify the interaction contracts with real state changes; a screenshot alone cannot validate a gesture, checkout integrity or persistence. The current package is the static visual and behavioral reference for that work.
