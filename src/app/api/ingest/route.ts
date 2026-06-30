import type { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runIngestion } from "@/lib/ai/agent";

// AI + web search are slow; never cache, and allow a long run on Vercel.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Scheduled ingestion endpoint. Called by Supabase pg_cron via pg_net with the
 * shared CRON_SECRET. Runs the agent with the service-role client (bypasses RLS
 * since there is no admin session in a cron context).
 */
export async function POST(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return Response.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }

  const auth = request.headers.get("authorization");
  const provided = auth?.replace(/^Bearer\s+/i, "") ?? request.headers.get("x-cron-secret");
  if (provided !== secret) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const db = createAdminClient();
    const stats = await runIngestion(db, { trigger: "cron" });
    return Response.json({ ok: true, ...stats });
  } catch (e) {
    const message = e instanceof Error ? e.message : "ingestion failed";
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
