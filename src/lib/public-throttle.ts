import "server-only";
import { createHmac } from "crypto";
import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Shared hour-bucket rate limiter for PUBLIC write endpoints (newsletter,
 * comments, ratings). Buckets are keyed by an HMAC digest of the caller's IP
 * — raw IPs are never stored — in the newsletter_throttle table, pruned
 * opportunistically. Deliberately best-effort: a lost race under-counts
 * slightly, which is fine for throttling, and any infrastructure error fails
 * OPEN (a broken throttle must never block real readers).
 */
export const PUBLIC_LIMITS = {
  sub: 5, // newsletter subscriptions / hr / IP
  survey: 10, // newsletter survey submissions / hr / IP
  comment: 5, // article comments / hr / IP
  rating: 10, // doctor ratings / hr / IP
} as const;

export async function publicRateLimited(kind: keyof typeof PUBLIC_LIMITS): Promise<boolean> {
  try {
    const db = createAdminClient();
    const h = await headers();
    const ip = (h.get("x-forwarded-for") ?? "unknown").split(",")[0].trim() || "unknown";
    const digest = createHmac("sha256", process.env.SUPABASE_SERVICE_ROLE_KEY!)
      .update(ip)
      .digest("hex")
      .slice(0, 32);
    const bucket = `${kind}:${digest}`;
    const windowStart = new Date(Math.floor(Date.now() / 3600_000) * 3600_000).toISOString();

    const { data: row } = await db
      .from("newsletter_throttle")
      .select("count")
      .eq("bucket", bucket)
      .eq("window_start", windowStart)
      .maybeSingle();

    if (row && row.count >= PUBLIC_LIMITS[kind]) return true;

    if (row) {
      await db
        .from("newsletter_throttle")
        .update({ count: row.count + 1 })
        .eq("bucket", bucket)
        .eq("window_start", windowStart);
    } else {
      await db.from("newsletter_throttle").insert({ bucket, window_start: windowStart });
      // Opportunistic prune — keeps the table tiny without a cron.
      await db
        .from("newsletter_throttle")
        .delete()
        .lt("window_start", new Date(Date.now() - 24 * 3600_000).toISOString());
    }
    return false;
  } catch {
    return false; // fail open: throttling is protection, not a gate
  }
}
