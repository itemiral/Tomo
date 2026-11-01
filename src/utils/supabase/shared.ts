import { createClient } from '@supabase/supabase-js';

export type GetSessionToken = () => Promise<string | null>;

export class SupabaseSessionError extends Error {
  readonly status = 401;

  constructor() {
    super('Sign in to access your workspace.');
    this.name = 'SupabaseSessionError';
  }
}

export function createAuthenticatedClient(getToken: GetSessionToken) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error('Supabase is not configured.');

  return createClient(url, key, {
    async accessToken() {
      const token = await getToken();
      if (!token) throw new SupabaseSessionError();
      return token;
    },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    db: { retry: false },
    global: {
      fetch: (input, init) => fetch(input, { ...init, cache: 'no-store' }),
    },
  });
}
