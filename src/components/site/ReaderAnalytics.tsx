"use client";

import { useEffect } from "react";
import {
  classifyInternalPath,
  classifyTraffic,
  type ReaderEvent,
} from "@/lib/reader-analytics";

/**
 * Reader Analytics V1 — anonymous, first-party, fire-and-forget.
 *
 * Mounted ONLY on the public /article and /video pages (never in the admin
 * preview, which reuses ArticleView). Renders nothing; failure is silent and
 * can never affect the reader.
 *
 * Events:
 *   view      — on mount.
 *   engaged   — once, when BOTH ≥30s on page AND ≥50% scrolled.
 *   completed — once, at ≥90% scroll.
 *
 * Privacy: the only stored state is `salma_sid`, a random UUID in
 * sessionStorage (per tab session, gone when the tab closes) used purely so
 * refreshes don't double-count. No cookies, no IPs, no identity, no
 * fingerprinting. Localhost/dev traffic is never tracked (override for
 * verification only: localStorage.salma_track_debug = "1").
 */

const ENGAGED_SECONDS = 30;
const ENGAGED_SCROLL = 0.5;
const COMPLETED_SCROLL = 0.9;

export function ReaderAnalytics({ contentId }: { contentId: string }) {
  useEffect(() => {
    try {
      const host = window.location.hostname;
      const isDev = host === "localhost" || host === "127.0.0.1" || host.endsWith(".local");
      let debug = false;
      try {
        debug = window.localStorage.getItem("salma_track_debug") === "1";
      } catch {
        /* storage blocked */
      }
      if (isDev && !debug) return;

      let sid = "";
      try {
        sid = window.sessionStorage.getItem("salma_sid") ?? "";
        if (!sid) {
          sid = crypto.randomUUID();
          window.sessionStorage.setItem("salma_sid", sid);
        }
      } catch {
        // sessionStorage unavailable (private mode edge cases): a per-render
        // id still dedupes refresh-free noise within this page view.
        sid = crypto.randomUUID();
      }

      // Internal discovery: Next's client-side routing never updates
      // document.referrer, so NavTracker (root layout) records the previous
      // in-app route. Effect ordering is handled both ways: if NavTracker
      // already processed this route, salma_cur_path equals it and the real
      // previous route sits in salma_prev_path; otherwise salma_cur_path IS
      // the previous route.
      let prevPath: string | null = null;
      try {
        const cur = window.sessionStorage.getItem("salma_cur_path");
        prevPath = cur && cur !== window.location.pathname
          ? cur
          : window.sessionStorage.getItem("salma_prev_path");
      } catch {
        /* fall back to referrer-only classification */
      }
      let { source, internal, referrerDomain } = classifyTraffic(
        document.referrer,
        host,
        new URLSearchParams(window.location.search).get("utm_source"),
      );
      if (prevPath && prevPath !== window.location.pathname) {
        source = "internal";
        internal = classifyInternalPath(prevPath);
        referrerDomain = null;
      }

      const send = (event: ReaderEvent) => {
        try {
          const payload = JSON.stringify({
            content_id: contentId,
            event,
            session: sid,
            source,
            internal_source: internal,
            referrer_domain: referrerDomain,
          });
          if (navigator.sendBeacon) {
            navigator.sendBeacon("/api/track", new Blob([payload], { type: "application/json" }));
          } else {
            fetch("/api/track", {
              method: "POST",
              body: payload,
              headers: { "Content-Type": "application/json" },
              keepalive: true,
            }).catch(() => {});
          }
        } catch {
          /* analytics must never throw */
        }
      };

      send("view");

      const start = Date.now();
      let maxScroll = 0;
      let engagedSent = false;
      let completedSent = false;
      let ticking = false;

      const scrollRatio = () => {
        const doc = document.documentElement;
        const total = doc.scrollHeight;
        if (total <= 0) return 0;
        return Math.min((window.scrollY + window.innerHeight) / total, 1);
      };

      const evaluate = () => {
        if (!completedSent && maxScroll >= COMPLETED_SCROLL) {
          completedSent = true;
          send("completed");
        }
        if (
          !engagedSent &&
          maxScroll >= ENGAGED_SCROLL &&
          Date.now() - start >= ENGAGED_SECONDS * 1000
        ) {
          engagedSent = true;
          send("engaged");
        }
      };

      const onScroll = () => {
        if (ticking) return;
        ticking = true;
        window.requestAnimationFrame(() => {
          ticking = false;
          maxScroll = Math.max(maxScroll, scrollRatio());
          evaluate();
        });
      };

      // The timer side of "engaged": re-check shortly after the threshold so
      // a reader who scrolled early still registers once 30s pass.
      const timer = window.setInterval(() => {
        maxScroll = Math.max(maxScroll, scrollRatio());
        evaluate();
        if (engagedSent && completedSent) window.clearInterval(timer);
      }, 5000);

      const onHide = () => evaluate(); // last chance before leaving (sendBeacon survives unload)

      window.addEventListener("scroll", onScroll, { passive: true });
      document.addEventListener("visibilitychange", onHide);
      maxScroll = scrollRatio();

      return () => {
        window.clearInterval(timer);
        window.removeEventListener("scroll", onScroll);
        document.removeEventListener("visibilitychange", onHide);
      };
    } catch {
      /* never affect the page */
    }
  }, [contentId]);

  return null;
}
