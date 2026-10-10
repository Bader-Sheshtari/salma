"use server";

import { createHash, createHmac, randomBytes } from "crypto";
import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  NEWSLETTER_CONSENT_VERSION,
  PREFER_NOT_SAY,
  filterMulti,
  validCountry,
  validFrequency,
  validNationality,
  validProfession,
  validSource,
} from "@/lib/newsletter";

/**
 * All newsletter writes go through these actions with the service-role client:
 * the table has no client INSERT policy, so the honeypot / rate-limit /
 * validation path cannot be bypassed with the public anon key.
 *
 * The optional survey is linked to a subscription by a one-time token (32
 * random bytes, base64url). Only its SHA-256 hash is stored, it expires after
 * 24h, and it is consumed on first successful save — there are no public
 * edit links.
 */

export type NewsletterResult =
  | { ok: true; already: boolean; surveyToken: string | null }
  | { ok: false; error: string };

export type SurveyResult = { ok: true; saved: boolean } | { ok: false; error: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GENERIC_ERROR = "تعذّر إتمام العملية، حاول لاحقاً.";
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

// -- rate limiting -----------------------------------------------------------
// Hour buckets keyed by an HMAC of the caller's IP (raw IPs are never stored).
// Deliberately best-effort: a lost race under-counts slightly, which is fine
// for throttling.
const LIMITS = { sub: 5, survey: 10 } as const;

async function rateLimited(kind: keyof typeof LIMITS): Promise<boolean> {
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

  if (row && row.count >= LIMITS[kind]) return true;

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
}

// -- subscribe ---------------------------------------------------------------

export async function subscribeNewsletter(
  _prev: NewsletterResult | null,
  formData: FormData,
): Promise<NewsletterResult> {
  try {
    // Honeypot: bots that fill the invisible field get a fake success and no
    // survey token; nothing is written.
    if (String(formData.get("website") ?? "").trim() !== "") {
      return { ok: true, already: false, surveyToken: null };
    }

    const email = String(formData.get("email") ?? "")
      .trim()
      .toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 254) {
      return { ok: false, error: "الرجاء إدخال بريد إلكتروني صحيح." };
    }

    const rawSource = String(formData.get("source") ?? "homepage");
    const source = validSource(rawSource) ? rawSource : "homepage";

    if (await rateLimited("sub")) {
      return { ok: false, error: "محاولات كثيرة خلال وقت قصير — حاول لاحقاً." };
    }

    const db = createAdminClient();
    const { data: existing, error: lookupError } = await db
      .from("newsletter_subscribers")
      .select("id, status")
      .eq("email", email)
      .maybeSingle();
    if (lookupError) return { ok: false, error: GENERIC_ERROR };

    // Already an active subscriber: no duplicate row, and no survey token —
    // an unauthenticated repeat submission must not be able to overwrite an
    // existing subscriber's survey answers (email isn't verified yet).
    if (existing && existing.status === "subscribed") {
      return { ok: true, already: true, surveyToken: null };
    }

    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const tokenExpiry = new Date(Date.now() + TOKEN_TTL_MS).toISOString();

    if (existing) {
      // Reactivate the same row: original subscribed_at and source preserved.
      const { error } = await db
        .from("newsletter_subscribers")
        .update({
          status: "subscribed",
          unsubscribed_at: null,
          consent_version: NEWSLETTER_CONSENT_VERSION,
          survey_token_hash: tokenHash,
          survey_token_expires_at: tokenExpiry,
        })
        .eq("id", existing.id)
        .eq("status", "unsubscribed");
      if (error) return { ok: false, error: GENERIC_ERROR };
      return { ok: true, already: false, surveyToken: token };
    }

    const { error } = await db.from("newsletter_subscribers").insert({
      email,
      status: "subscribed",
      source,
      consent_version: NEWSLETTER_CONSENT_VERSION,
      survey_token_hash: tokenHash,
      survey_token_expires_at: tokenExpiry,
    });
    if (error) {
      // Unique-index race on lower(email): the email is subscribed either way.
      if (error.code === "23505") return { ok: true, already: true, surveyToken: null };
      return { ok: false, error: GENERIC_ERROR };
    }
    return { ok: true, already: false, surveyToken: token };
  } catch {
    return { ok: false, error: GENERIC_ERROR };
  }
}

// -- optional audience survey ------------------------------------------------

export async function submitAudienceSurvey(
  _prev: SurveyResult | null,
  formData: FormData,
): Promise<SurveyResult> {
  try {
    const token = String(formData.get("token") ?? "");
    if (token.length < 20 || token.length > 100) return { ok: false, error: GENERIC_ERROR };

    if (await rateLimited("survey")) {
      return { ok: false, error: "محاولات كثيرة خلال وقت قصير — حاول لاحقاً." };
    }

    const tokenHash = createHash("sha256").update(token).digest("hex");
    const db = createAdminClient();
    const { data: sub } = await db
      .from("newsletter_subscribers")
      .select("id, survey_token_expires_at")
      .eq("survey_token_hash", tokenHash)
      .eq("status", "subscribed")
      .maybeSingle();
    if (
      !sub ||
      !sub.survey_token_expires_at ||
      new Date(sub.survey_token_expires_at).getTime() < Date.now()
    ) {
      return { ok: false, error: "انتهت صلاحية هذه الجلسة. اشتراكك في النشرة قائم ولا يتأثر." };
    }

    // Every question is individually optional: collect only what was answered,
    // drop anything outside the catalogs. Nationality/residence come ONLY from
    // the subscriber's explicit selection — never inferred.
    const str = (k: string) => String(formData.get(k) ?? "").trim();
    const multi = (k: string) => formData.getAll(k).map((v) => String(v));

    const answers: Record<string, unknown> = {};
    const profession = str("profession");
    if (validProfession(profession)) answers.profession_type = profession;

    const reasons = filterMulti(multi("reasons"), "reasons");
    if (reasons.length > 0) answers.interest_reasons = reasons;
    const reasonOther = str("reason_other").slice(0, 280);
    if (reasons.includes("other") && reasonOther) answers.interest_reason_other = reasonOther;

    const topics = filterMulti(multi("topics"), "topics");
    if (topics.length > 0) answers.topics = topics;

    const prefs = filterMulti(multi("content_preferences"), "content");
    if (prefs.length > 0) answers.content_preferences = prefs;

    const frequency = str("frequency");
    if (validFrequency(frequency)) answers.preferred_frequency = frequency;

    const residence = str("residence");
    if (validCountry(residence)) answers.country_of_residence = residence;

    const nationality = str("nationality");
    if (validNationality(nationality)) {
      answers.nationality = nationality === PREFER_NOT_SAY ? PREFER_NOT_SAY : nationality;
    }

    // Nothing answered = same as skipping; the subscription stays intact.
    if (Object.keys(answers).length === 0) return { ok: true, saved: false };

    const { data: existingProfile } = await db
      .from("newsletter_audience_profiles")
      .select("subscriber_id")
      .eq("subscriber_id", sub.id)
      .maybeSingle();

    const now = new Date().toISOString();
    const write = existingProfile
      ? db
          .from("newsletter_audience_profiles")
          .update({ ...answers, survey_updated_at: now })
          .eq("subscriber_id", sub.id)
      : db
          .from("newsletter_audience_profiles")
          .insert({ subscriber_id: sub.id, ...answers, survey_completed_at: now });
    const { error } = await write;
    if (error) return { ok: false, error: GENERIC_ERROR };

    // Consume the token: one successful save per signup session.
    await db
      .from("newsletter_subscribers")
      .update({ survey_token_hash: null, survey_token_expires_at: null })
      .eq("id", sub.id);

    return { ok: true, saved: true };
  } catch {
    return { ok: false, error: GENERIC_ERROR };
  }
}
