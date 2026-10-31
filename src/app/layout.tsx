import type { Metadata, Viewport } from 'next';
import { ClerkProvider } from '@clerk/nextjs';
import './globals.css';
export const metadata: Metadata = {
  title: 'Muse Board — your whiteboard',
  description: 'A little room for big ideas. Draw, write, and connect ideas with Muse Board.',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body><ClerkProvider signInUrl="/sign-in" signUpUrl="/sign-up" signInFallbackRedirectUrl="/" signUpFallbackRedirectUrl="/" appearance={{ options: { socialButtonsVariant: 'blockButton' }, variables: { colorPrimary: '#5277ee', borderRadius: '12px' } }}>{children}</ClerkProvider></body></html>;
}
