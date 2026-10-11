import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  INTERNAL_SOURCES,
  READER_EVENTS,
  TRAFFIC_SOURCES,
} from "@/lib/reader-analytics";

/**
 * Reader Analytics V1 ingestion. Fire-and-forget from the public article
 * pages (sendBeacon): ALWAYS answers 204 — analytics can never surface an
 * error to a reader or block rendering.
 *
 * Server-side guarantees:
 *  - only the three known events, validated enums, bounded field sizes;
 *  - the target article must be PUBLISHED and not deleted (draft/pending/
 *    unpublished/rejected/trash can never accumulate public analytics);
 *  - obvious crawler/bot user agents are dropped;
 *  - deduplication via the unique (content_id, session_key, event) index —
 *    refreshes in the same tab session can never inflate a metric;
 *  - nothing identifying is read or stored: no IPs, no cookies, no identity.
 */

const BOT_RE =
  /bot|crawler|spider|crawling|headless|lighthouse|pingdom|facebookexternalhit|preview|curl|wget|python-requests|slurp|bingpreview/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ok = () => new NextResponse(null, { status: 204 });

export async function POST(req: NextRequest) {
  try {
    const ua = req.headers.get("user-agent") ?? "";
    if (!ua || BOT_RE.test(ua)) return ok();

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return ok();

    const contentId = String(body.content_id ?? "");
    const event = String(body.event ?? "");
    const session = String(body.session ?? "");
    const source = String(body.source ?? "");
    const internal = body.internal_source == null ? null : String(body.internal_source);
    const refDomain = body.referrer_domain == null ? null : String(body.referrer_domain).slice(0, 100);

    if (!UUID_RE.test(contentId)) return ok();
    if (!(READER_EVENTS as readonly string[]).includes(event)) return ok();
    if (session.length < 8 || session.length > 64) return ok();
    if (!(TRAFFIC_SOURCES as readonly string[]).includes(source)) return ok();
    if (internal !== null && !(INTERNAL_SOURCES as readonly string[]).includes(internal)) return ok();

    const db = createAdminClient();
    const { data: target } = await db
      .from("content")
      .select("id")
      .eq("id", contentId)
      .eq("status", "published")
      .is("deleted_at", null)
      .maybeSingle();
    if (!target) return ok();

    // Unique (content_id, session_key, event) absorbs refreshes/duplicates.
    await (db as unknown as {
      from: (t: string) => {
        upsert: (v: unknown, o: { onConflict: string; ignoreDuplicates: boolean }) => Promise<unknown>;
      };
    })
      .from("reader_events")
      .upsert(
        {
          content_id: contentId,
          event,
          session_key: session.slice(0, 64),
          source,
          internal_source: internal,
          referrer_domain: refDomain,
        },
        { onConflict: "content_id,session_key,event", ignoreDuplicates: true },
      );
    return ok();
  } catch {
    return ok();
  }
}
