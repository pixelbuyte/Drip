import type { Metadata } from 'next';
import { Bricolage_Grotesque, Instrument_Sans, Martian_Mono } from 'next/font/google';
import './globals.css';

const display = Bricolage_Grotesque({
  variable: '--font-bricolage',
  subsets: ['latin'],
  display: 'swap',
});

const sans = Instrument_Sans({
  variable: '--font-instrument',
  subsets: ['latin'],
  display: 'swap',
});

const mono = Martian_Mono({
  variable: '--font-martian',
  subsets: ['latin'],
  display: 'swap',
  weight: ['400', '600'],
});

export const metadata: Metadata = {
  title: 'Drip — sell it where they already watch',
  description:
    'Post a 60-second video, tag it with a price, and share one link. Buyers tap once and check out. No storefront to build, no marketplace to get lost in.',
  openGraph: {
    title: 'Drip — sell it where they already watch',
    description: 'One video. One link. One tap to buy.',
    type: 'website',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${sans.variable} ${mono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
