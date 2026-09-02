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
  // No themeColor here on purpose. A media-based theme-color can only follow
  // the *system* colour scheme, but the app has its own theme toggle
  // (data-theme) that overrides it — so a dark-in-app choice on a light phone
  // left the status bar tinted cream over a black app. The tag is created and
  // kept in sync with the resolved theme by the pre-paint script below and by
  // applyTheme in ReaderControls.
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
  // Tint the phone's status bar to match the resolved theme, not the system
  // scheme — otherwise a dark-in-app choice on a light phone leaves a cream
  // bar over a black app. sepia keeps the app chrome (--bg) cream.
  var mq=window.matchMedia("(prefers-color-scheme: dark)");
  function paintBar(){
    var dark = t==="dark" || (!t && mq.matches);
    var c = dark ? "#000000" : "#faf9f5";
    var m = document.querySelector('meta[name="theme-color"]');
    if(!m){m=document.createElement("meta");m.setAttribute("name","theme-color");document.head.appendChild(m);}
    m.setAttribute("content", c);
  }
  paintBar();
  // Follow the system if the user never made an explicit choice.
  if(!t)mq.addEventListener("change", paintBar);
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
