import { SignUp } from '@clerk/nextjs';
import { Suspense } from 'react';

export default function SignUpPage() {
  return <main className="muze-auth-page"><Suspense><SignUp/></Suspense></main>;
}
