import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'Muse — your visual workspace',
  description: 'Think, explore, and make plans with your Muses on one shared whiteboard.',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" className="dark"><body>{children}</body></html>;
}
