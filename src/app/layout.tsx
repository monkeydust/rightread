import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ServiceWorker } from "@/components/ServiceWorker";
import { OutboxSync } from "@/components/OutboxSync";
import { serif, sans } from "./fonts";

export const metadata: Metadata = {
  title: "rightread",
  description: "Capture links from anywhere. Read them clean, later, offline.",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [{ url: "/favicon.png", type: "image/png", sizes: "32x32" }],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
  appleWebApp: {
    capable: true,
    title: "rightread",
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#faf9f5" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${serif.variable} ${sans.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/*
          Applies the saved reader preferences before first paint. Without
          this the article renders at the default size and theme for a frame
          and then snaps, which is very visible on a slow phone.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{
  var d=document.documentElement, s=localStorage.getItem("rr:scale"), w=localStorage.getItem("rr:width"), t=localStorage.getItem("rr:theme");
  var S=[0.85,0.925,1,1.1,1.25,1.45], W=["34rem","40rem","48rem"];
  if(S[s])d.style.setProperty("--reader-scale",S[s]);
  if(W[w])d.style.setProperty("--reader-width",W[w]);
  if(t)d.dataset.theme=t;
}catch(e){}})()`,
          }}
        />
      </head>
      <body>
        {children}
        <ServiceWorker />
        {/* Not inside AppShell: the reader has its own chrome, and marking an
            article read is the likeliest thing to have been queued. */}
        <OutboxSync />
      </body>
    </html>
  );
}
