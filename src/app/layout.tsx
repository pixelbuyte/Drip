import type { Metadata } from 'next';
import { Bricolage_Grotesque, Caveat, Hanken_Grotesk } from 'next/font/google';
import './globals.css';

// Bricolage at high optical sizes for headlines; Hanken for every card title,
// price, button and chip; Caveat only for the hero's handwritten annotation.
// All three variable.
const display = Bricolage_Grotesque({
  variable: '--font-bricolage',
  subsets: ['latin'],
  display: 'swap',
  axes: ['opsz'],
});

const sans = Hanken_Grotesk({
  variable: '--font-hanken',
  subsets: ['latin'],
  display: 'swap',
});

const hand = Caveat({
  variable: '--font-caveat',
  subsets: ['latin'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Drip — See it. Want it. Buy it.',
  description:
    'Video-first shopping. Scroll short videos from creators you trust and buy the featured item straight from the video. Every category, on camera.',
  openGraph: {
    title: 'Drip — See it. Want it. Buy it.',
    description: 'Shop what creators love. Every category, on camera.',
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
      className={`${display.variable} ${sans.variable} ${hand.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
