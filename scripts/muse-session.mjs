class SessionError extends Error {
  constructor() {
    super('Sign in to access your workspace.');
    this.name = 'SupabaseSessionError';
    this.status = 401;
  }
}

// Inputs come from verified server authentication, never from a request body.
export function refreshingSessionToken({ userId, sessionId, initialToken, refreshToken, now = Date.now }) {
  let cached;
  let loading;
  let refreshing;
  const claims = token => {
    try {
      const value = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
      if (value.sub !== userId || value.sid !== sessionId || !Number.isFinite(value.exp)) throw new SessionError();
      return value;
    } catch { throw new SessionError(); }
  };
  return async () => {
    if (!userId || !sessionId) throw new SessionError();
    if (!loading) loading = Promise.resolve().then(initialToken).then(token => {
      if (!token) throw new SessionError();
      claims(token);
      cached = token;
    });
    await loading;
    if (claims(cached).exp * 1000 > now() + 15_000) return cached;
    if (!refreshing) refreshing = Promise.resolve().then(refreshToken).then(token => {
      if (!token || claims(token).exp * 1000 <= now() + 15_000) throw new SessionError();
      cached = token;
      return token;
    }).finally(() => { refreshing = undefined; });
    return refreshing;
  };
}
