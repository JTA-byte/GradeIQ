import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GradeIQ — Grader recommendation engine",
  description:
    "AI-powered grading recommendations for Pokémon TCG cards, blending vision analysis with grader-specific gem rate and market data.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
