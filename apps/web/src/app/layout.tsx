import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'HITL Approval Layer',
  description: 'Human-in-the-loop approval portal and policy console for AI workflows',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
