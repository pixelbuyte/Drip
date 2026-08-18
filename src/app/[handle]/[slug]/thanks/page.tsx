import { createPublicClient } from '@/lib/supabase-public';
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

type Params = { handle: string; slug: string };

export default async function ThanksPage({ params }: { params: Promise<Params> }) {
  const { handle: handleParam, slug } = await params;
  const decoded = decodeURIComponent(handleParam);
  if (!decoded.startsWith('@')) notFound();
  const handle = decoded.slice(1);

  const supabase = createPublicClient();
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, handle, display_name')
    .eq('handle', handle)
    .single();

  if (!profile) notFound();

  const { data: drop } = await supabase
    .from('drops')
    .select('title')
    .eq('seller_id', profile.id)
    .eq('slug', slug)
    .single();

  return (
    <div className="grain flex min-h-dvh flex-col items-center justify-center bg-ink px-5">
      <div className="relative z-10 w-full max-w-md text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border border-acid/40 bg-acid/10 font-mono text-2xl text-acid">
          ✓
        </div>
        <h1 className="mt-7 font-display text-3xl font-extrabold tracking-tight text-paper">
          Order confirmed
        </h1>
        <p className="mt-4 text-sm leading-relaxed text-dim">
          {drop ? (
            <>
              You bought <span className="text-paper">{drop.title}</span> from @{profile.handle}.
            </>
          ) : (
            <>Thanks for your order from @{profile.handle}.</>
          )}{' '}
          A receipt is on its way to your email, and tracking follows as soon as it ships.
        </p>
        <p className="mt-10 font-mono text-[0.65rem] uppercase tracking-[0.25em] text-dim/60">
          Powered by Drip
        </p>
      </div>
    </div>
  );
}
