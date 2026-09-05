"use client";

import { useEffect } from "react";
import { invalidateArticleCache } from "@/lib/sw-invalidate";

/**
 * Registers the offline reader service worker. No-op where unsupported.
 *
 * Also picks up a deploy. The worker uses skipWaiting + clients.claim, so a
 * new version takes over the caches within a second of the first open after
 * a deploy — but the page that triggered it is already running the previous
 * build's JavaScript, and keeps running it until something reloads. That was
 * the "close and reopen the app" step after every deploy. So: when a new
 * worker replaces an existing one, reload once. Never on first install (there
 * is nothing to replace), and never out from under someone typing — then it
 * waits until they leave and come back.
 */
export function ServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV !== "production") return;

    // Captured before registering: a controller here means a worker was
    // already in charge of this page, so any change is an update, not a
    // first install.
    const hadController = Boolean(navigator.serviceWorker.controller);

    const register = () => {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .catch((err) => console.error("[rightread] SW registration failed", err));
    };

    // Registering after load keeps it off the critical path.
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });

    if (!hadController) return;

    const typing = () => {
      const el = document.activeElement;
      return (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLElement && el.isContentEditable)
      );
    };

    const reload = async () => {
      // An article page is cache-first, and the cached document belongs to
      // the build that just went away. Forget it so the reload reaches the
      // server rather than reviving markup that points at deleted chunks.
      if (location.pathname.startsWith("/read/")) {
        await invalidateArticleCache(location.pathname);
      }
      location.reload();
    };

    let pending = false;
    const onVisible = () => {
      if (document.visibilityState === "visible" && pending && !typing()) {
        pending = false;
        void reload();
      }
    };

    const onControllerChange = () => {
      if (typing()) {
        // Come back to it when they return to the app.
        pending = true;
        document.addEventListener("visibilitychange", onVisible);
        return;
      }
      void reload();
    };

    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return null;
}
