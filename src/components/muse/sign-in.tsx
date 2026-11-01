'use client';

import { SignInButton, useUser } from '@clerk/nextjs';

export function SignInToShare() {
  const { isLoaded, isSignedIn } = useUser();
  if (!isLoaded || isSignedIn) return null;
  return <SignInButton mode="modal"><button type="button" className="muze-sign-in">Sign in to share</button></SignInButton>;
}
