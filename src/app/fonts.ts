import { Source_Serif_4, Inter } from "next/font/google";

/**
 * Claude's own faces are Tiempos Text (body) and Styrene (UI) — both
 * commercially licensed, so they can't be bundled here. These are the closest
 * freely-licensed stand-ins:
 *
 *  - Source Serif 4 — transitional serif in the same Times-descended lineage
 *    as Tiempos: high x-height, restrained contrast, built for long reading.
 *  - Inter — neutral grotesque standing in for Styrene.
 *
 * next/font downloads these at build time and serves them from our own origin,
 * so there is no third-party request and they stay available offline.
 */
export const serif = Source_Serif_4({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-reader-serif",
  weight: ["400", "600"],
  style: ["normal", "italic"],
});

export const sans = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-reader-sans",
});
