import type { Metadata } from 'next';
import { Schibsted_Grotesk, IBM_Plex_Mono, Newsreader } from 'next/font/google';
import './globals.css';

// Schibsted carries display and body both: a newspaper grotesk drawn for text,
// so the page needs three families rather than four. Never set above 600 —
// heavy weights are how landing pages shout.
const display = Schibsted_Grotesk({
  variable: '--font-schibsted',
  subsets: ['latin'],
  display: 'swap',
});

// Every figure on the site is set in this: dollar amounts, timestamps, handles,
// tracking numbers, status labels. Plex reads as back-office finance rather
// than as a developer tool.
const mono = IBM_Plex_Mono({
  variable: '--font-plex-mono',
  subsets: ['latin'],
  weight: ['400', '500'],
  display: 'swap',
});

// Bone chapter only, below the fold — so it never gates LCP.
const serif = Newsreader({
  variable: '--font-newsreader',
  subsets: ['latin'],
  display: 'swap',
  preload: false,
  axes: ['opsz'],
});

export const metadata: Metadata = {
  title: 'Drip — she posts the video, the video is the store',
  description:
    'Upload one vertical video. Tag it with a price. Share one link. Buyers watch full-screen and tap once — no account, no app. Drip buys the USPS label and emails the tracking.',
  openGraph: {
    title: 'Drip — she posts the video, the video is the store',
    description: 'One video. One link. Two taps to paid.',
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
      className={`${display.variable} ${mono.variable} ${serif.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
