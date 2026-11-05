import type { Metadata } from "next";
import { Footer, Header } from "@/components/site-chrome";
import "./globals.css";

export const metadata: Metadata = {
  title: "Udhaar: invoice financing on Hedera",
  description: "Turn unpaid invoices into cash today. Testnet demo.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col antialiased">
        <Header />
        <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
