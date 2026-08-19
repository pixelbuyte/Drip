# Abandoned fork — DO NOT APPLY

These four migrations (00003–00006) were written in June 2026 but **never
applied to production**. Production went a different way: five out-of-band
migrations (`mvp_storefront_and_security`, `checkout_drop_info_fn`,
`public_profiles_view`, `split_seller_pii`, `drop_checkout_drop_info_fn`)
ran instead, and `00006_reconcile_forked_schema.sql` in the parent
directory replays everything these files did that still matters — adapted
to the schema production actually has.

They are kept here for the historical record only. They live outside the
migrations directory precisely so that no version-ordered tool
(`supabase db push`, CI replay, a dev following the README) can ever apply
them: running them against production commits several fork-order changes
(a rewritten `decrement_inventory` signature under the live app, a
different `drops_status_check`) before wedging at `00006_lock_down_rls`,
which references `profiles.from_address` — a column the PII split removed.
That failure mode was reproduced verbatim against a replica of production
before this directory existed.

If you think you need something from these files, the reconcile migration
almost certainly already has it. Read its header first.
