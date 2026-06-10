import { createServerClient_ } from './supabase-server';
import { redirect } from 'next/navigation';

export async function getSession() {
  const supabase = await createServerClient_();
  const { data, error } = await supabase.auth.getSession();

  if (error) {
    throw error;
  }

  return data.session;
}

export async function requireAuth() {
  const session = await getSession();

  if (!session) {
    redirect('/auth/login');
  }

  return session;
}

export async function getUserProfile() {
  const session = await requireAuth();
  const supabase = await createServerClient_();

  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', session.user.id)
    .single();

  if (error) {
    throw error;
  }

  return data;
}
