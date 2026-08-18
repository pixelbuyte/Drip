import type { Metadata } from 'next';
import { Bricolage_Grotesque, Hanken_Grotesk } from 'next/font/google';
import './globals.css';

// Bricolage at high optical sizes for headlines; Hanken for every card title,
// price, button and chip. Both variable.
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

export const metadata: Metadata = {
  title: 'Drip — your new favorite way to shop',
  description:
    'Scroll through things you actually want. Save what is good, watch prices drop, and shop straight from people with taste.',
  openGraph: {
    title: 'Drip — your new favorite way to shop',
    description: 'The feed is the store. Scroll, save, shop.',
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
      className={`${display.variable} ${sans.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
