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
    <div className="flex min-h-dvh flex-col items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md space-y-4 text-center">
        <div className="text-6xl">✅</div>
        <h1 className="text-2xl font-bold text-gray-900">Order confirmed!</h1>
        <p className="text-gray-600">
          {drop ? `You bought "${drop.title}" from @${profile.handle}.` : `Thanks for your order from @${profile.handle}.`}{' '}
          A receipt is on its way to your email, and you'll get tracking info as soon as it ships.
        </p>
        <p className="pt-4 text-xs text-gray-400">Powered by Drip</p>
      </div>
    </div>
  );
}
