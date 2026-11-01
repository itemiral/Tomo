'use client';

import { SignInButton, useUser } from '@clerk/nextjs';

export function SignInToShare() {
  const { isLoaded, isSignedIn } = useUser();
  if (isSignedIn) return null;
  return <SignInButton mode="modal"><button type="button" className="muze-sign-in" disabled={!isLoaded}>Sign in to share</button></SignInButton>;
}
