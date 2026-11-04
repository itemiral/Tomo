import type { Metadata, Viewport } from 'next';
import { ClerkProvider } from '@clerk/nextjs';
import { authAppearance, authLocalization } from '@/components/muse/auth-appearance';
import './globals.css';
export const metadata: Metadata = {
  title: 'Tomo — your whiteboard',
  description: 'Draw, write, and connect ideas with your Muse.',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body><ClerkProvider signInUrl="/sign-in" signUpUrl="/sign-up" signInFallbackRedirectUrl="/" signUpFallbackRedirectUrl="/" appearance={authAppearance} localization={authLocalization}>{children}</ClerkProvider></body></html>;
}
