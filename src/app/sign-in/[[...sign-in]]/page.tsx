import { SignIn } from '@clerk/nextjs';
import { Suspense } from 'react';

export default function SignInPage() {
  return <main className="muze-auth-page"><Suspense><SignIn/></Suspense></main>;
}
