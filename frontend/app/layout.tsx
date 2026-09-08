import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Sattvic Trading Dashboard",
  description: "Market data dashboard powered by FastAPI, MongoDB, and Redis.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased">{children}</body>
    </html>
  );
}
