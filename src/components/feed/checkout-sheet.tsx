'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import {
  Elements, PaymentElement, AddressElement, useElements, useStripe,
} from '@stripe/react-stripe-js';
import { emit } from '@/lib/events/client';

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

let stripePromise: Promise<Stripe | null> | null = null;
function stripeJs() {
  if (!stripePromise) {
    const key = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
    stripePromise = key ? loadStripe(key) : Promise.resolve(null);
  }
  return stripePromise;
}

export type CheckoutRequest = {
  videoId: string;
  productId: string;
  quantity: number;
  selection: Record<string, string>;
};

type Quote = {
  clientSecret: string;
  paymentIntentId: string;
  subtotalCents: number;
  shippingCents: number;
  totalCents: number;
  title: string;
  sellerHandle: string;
};

/** The form. Split out because it must sit inside <Elements>. */
function PayForm({
  quote,
  req,
  onPaid,
}: {
  quote: Quote;
  req: CheckoutRequest;
  onPaid: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const submit = async () => {
    if (!stripe || !elements || submitting) return;
    setSubmitting(true);
    setError(null);
    const { error: err } = await stripe.confirmPayment({
      elements,
      redirect: 'if_required',
    });
    if (err) {
      setSubmitting(false);
      setError(
        err.type === 'card_error' || err.type === 'validation_error'
          ? (err.message ?? 'That card was declined. Nothing was charged.')
          : 'Something went wrong on our side. You have not been charged.'
      );
      return;
    }
    emit({
      t: 'purchase',
      v: req.videoId,
      p: req.productId,
      meta: { intent: quote.paymentIntentId, total: quote.totalCents },
    });
    onPaid();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-5">
        {/* Order summary is one collapsed line, expandable. */}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="flex w-full items-center justify-between rounded-[14px] bg-cream px-4 py-3 text-left"
        >
          <span data-num className="text-[14px] font-semibold text-ink">
            1 item · {money(quote.subtotalCents)} + {money(quote.shippingCents)} shipping ={' '}
            {money(quote.totalCents)}
          </span>
          <span className="ml-2 text-muted" aria-hidden>{expanded ? '▲' : '▼'}</span>
        </button>
        {expanded && (
          <dl className="mt-2 space-y-1 px-4 text-[13px]">
            <div className="flex justify-between">
              <dt className="text-muted">{quote.title}</dt>
              <dd data-num className="text-ink">{money(quote.subtotalCents)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">Shipping (USPS)</dt>
              <dd data-num className="text-ink">{money(quote.shippingCents)}</dd>
            </div>
          </dl>
        )}

        {/* One screen: email, address and payment all visible on one scroll.
            The Payment Element renders wallets at the top when available, which
            for most mobile buyers is the entire checkout. */}
        <div className="mt-4 space-y-4">
          <PaymentElement options={{ layout: 'accordion' }} />
          <AddressElement options={{ mode: 'shipping', allowedCountries: ['US'] }} />
        </div>

        {error && (
          <p className="mt-4 rounded-[12px] border-l-[3px] border-sale bg-sale/5 px-3 py-2 text-[13px] text-ink">
            {error}
          </p>
        )}
        <div className="h-28" />
      </div>

      <div className="shrink-0 border-t border-hairline bg-card px-5 pb-3 pt-3">
        <button
          type="button"
          onClick={submit}
          disabled={submitting || !stripe}
          className="relative w-full overflow-hidden rounded-full bg-coral py-3.5 text-[16px] font-bold text-ink shadow-cta disabled:opacity-70"
        >
          {/* Determinate progress, never a spinner over a blank screen. */}
          {submitting && (
            <span
              className="absolute inset-y-0 left-0 bg-black/10"
              style={{ width: '100%', animation: 'none' }}
              aria-hidden
            />
          )}
          <span className="relative">
            {submitting ? 'Paying…' : `Pay ${money(quote.totalCents)}`}
          </span>
        </button>
        <p className="mt-2 text-center text-[11px] font-medium uppercase tracking-[0.06em] text-muted">
          Secured by Stripe · no account needed
        </p>
      </div>
    </div>
  );
}

export default function CheckoutSheet({
  request,
  onClose,
  onKeepWatching,
}: {
  request: CheckoutRequest | null;
  onClose: () => void;
  onKeepWatching: () => void;
}) {
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paid, setPaid] = useState(false);
  // Generated once when the sheet opens: a double-submit or a retried request
  // must never create a second charge.
  const idempotencyKey = useRef<string>('');

  useEffect(() => {
    if (!request) {
      setQuote(null);
      setPaid(false);
      setError(null);
      return;
    }
    idempotencyKey.current = crypto.randomUUID().replace(/-/g, '');
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/checkout/intent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({
            video_id: request.videoId,
            product_id: request.productId,
            quantity: request.quantity,
            selection: request.selection,
            idempotency_key: idempotencyKey.current,
          }),
        });
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(
            data.code === 'sold_out'
              ? 'That just sold out. You have not been charged.'
              : (data.error ?? 'Could not start checkout.')
          );
          return;
        }
        setQuote(data as Quote);
      } catch {
        if (!cancelled) setError('Could not reach checkout. Check your connection.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [request]);

  const dismiss = useCallback(() => {
    if (request && !paid) {
      emit({
        t: 'checkout_abandon',
        v: request.videoId,
        p: request.productId,
        meta: { step: quote ? 'payment' : 'quote' },
      });
    }
    onClose();
  }, [request, paid, quote, onClose]);

  const options = useMemo(
    () =>
      quote
        ? ({ clientSecret: quote.clientSecret, appearance: { theme: 'flat' as const } })
        : undefined,
    [quote]
  );

  if (!request) return null;

  return (
    <div className="fixed inset-0 z-[60]" role="presentation">
      <div className="absolute inset-0 bg-black/60" onClick={dismiss} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Checkout"
        className="absolute inset-x-0 bottom-0 flex flex-col rounded-t-[24px] bg-card"
        style={{ height: '92dvh', paddingBottom: 'env(safe-area-inset-bottom,0px)' }}
      >
        <div className="flex shrink-0 items-center justify-between px-5 pb-2 pt-4">
          <h2 className="text-[17px] font-bold text-ink">
            {paid ? 'Order confirmed' : 'Checkout'}
          </h2>
          <button
            onClick={dismiss}
            aria-label="Close checkout"
            className="grid h-9 w-9 place-items-center rounded-full bg-cream text-ink"
          >
            ✕
          </button>
        </div>

        {/* Success transforms the sheet in place — no route change, no
            separate order page. The purchase should feel like it cost the
            viewer nothing in momentum. */}
        {paid ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-8 text-center">
            <span className="grid h-14 w-14 place-items-center rounded-full bg-lime text-[24px]" aria-hidden>
              ✓
            </span>
            <p className="mt-5 text-[18px] font-bold text-ink">You got it.</p>
            <p className="mt-2 max-w-[30ch] text-[14px] leading-relaxed text-muted">
              A receipt is on its way, and tracking follows the moment the label prints.
            </p>
            <button
              onClick={onKeepWatching}
              className="mt-8 rounded-full bg-coral px-7 py-3 text-[15px] font-bold text-ink shadow-cta"
            >
              Keep watching
            </button>
          </div>
        ) : error ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-8 text-center">
            <p className="text-[15px] font-semibold text-ink">{error}</p>
            <button
              onClick={dismiss}
              className="mt-6 rounded-full border border-hairline-strong px-6 py-3 text-[14px] font-bold text-ink"
            >
              Back to the video
            </button>
          </div>
        ) : !quote || !options ? (
          <div className="flex min-h-0 flex-1 flex-col gap-3 px-5 pt-2">
            {/* Skeletons shaped like the real content, never a generic spinner. */}
            <div className="h-12 animate-pulse rounded-[14px] bg-cream" />
            <div className="h-40 animate-pulse rounded-[14px] bg-cream" />
            <div className="h-32 animate-pulse rounded-[14px] bg-cream" />
          </div>
        ) : (
          <Elements stripe={stripeJs()} options={options}>
            <PayForm quote={quote} req={request} onPaid={() => setPaid(true)} />
          </Elements>
        )}
      </div>
    </div>
  );
}
