import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SimpleNode",
  description: "Canvas à nœuds pour la génération IA",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="fr">
      <body className="antialiased">{children}</body>
    </html>
  );
}
