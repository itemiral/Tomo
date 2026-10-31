import type { Metadata, Viewport } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'Muse Board — your whiteboard',
  description: 'A little room for big ideas. Draw, write, and connect ideas with Muse Board.',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
