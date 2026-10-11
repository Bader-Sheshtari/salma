"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

/**
 * Records the previous in-app route in sessionStorage so Reader Analytics can
 * attribute internal discovery (homepage/category/search/related → article):
 * Next's client-side routing never updates document.referrer, so the referrer
 * alone cannot see in-app navigation. Stores two path strings per tab session
 * and nothing else — no identity, no history list, nothing sent anywhere.
 */
export function NavTracker() {
  const pathname = usePathname();
  useEffect(() => {
    try {
      const cur = window.sessionStorage.getItem("salma_cur_path");
      if (cur && cur !== pathname) window.sessionStorage.setItem("salma_prev_path", cur);
      window.sessionStorage.setItem("salma_cur_path", pathname);
    } catch {
      /* storage unavailable — internal attribution falls back to referrer */
    }
  }, [pathname]);
  return null;
}
