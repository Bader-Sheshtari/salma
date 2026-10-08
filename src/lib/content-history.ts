/**
 * Shared (client + server) model for the article history screens (CMS Phase 4):
 * activity timeline rows, version rows, field labels and the Arabic sentence
 * for each audit event. No server-only imports — client components use it too.
 */

import { SYSTEM_AUTHOR_LABEL, STATUS_LABEL_AR } from "@/lib/content-search";

/** Label for a NULL actor (pipeline / service role / unknown user). */
export const SYSTEM_ACTOR_LABEL = SYSTEM_AUTHOR_LABEL; // «سلمى (آلي)»

export const HISTORY_PAGE_SIZE = 20;

/** Details payload written by content_lifecycle_after (field NAMES only). */
export type AuditDetails = {
  fields?: string[];
  flags?: string[];
  restored_from?: number;
  illegal_transition?: boolean;
  slug_changed_after_publish?: boolean;
  seed?: boolean;
};

/** One content_audit_log row + resolved actor name. */
export type AuditEvent = {
  id: number;
  event: string;
  from_status: string | null;
  to_status: string | null;
  actor_id: string | null;
  actor_kind: string;
  actor_name: string;
  version_no: number | null;
  details: AuditDetails | null;
  created_at: string;
};

export type AuditCursor = { ts: string; id: number };

/**
 * One stored version (metadata only — never body). `author_*` is who produced
 * this version and when: a snapshot row's own edited_by/edited_at record who
 * SUPERSEDED it (the edit that created version N+1), so the author of version N
 * comes from snapshot N-1 (or the article's creation for version 1).
 */
export type VersionMeta = {
  version_no: number;
  author_name: string | null;
  authored_at: string | null;
};

/** A full stored version (single-version view). */
export type VersionSnapshot = {
  content_id: string;
  version_no: number;
  title: string;
  slug: string;
  excerpt: string | null;
  body: string | null;
  ai_summary: string | null;
  category_slug: string | null;
  type: string;
  cover_image_url: string | null;
  cover_credit_name: string | null;
  cover_credit_url: string | null;
  source_name: string | null;
  source_url: string | null;
  video_url: string | null;
  edited_by: string | null;
  edited_at: string;
};

/** Fields restore_content_version writes back (slug is never restored). */
export const RESTORABLE_FIELDS = [
  "title",
  "excerpt",
  "body",
  "ai_summary",
  "category_slug",
  "type",
  "cover_image_url",
  "cover_credit_name",
  "cover_credit_url",
  "source_name",
  "source_url",
  "video_url",
] as const;
export type RestorableField = (typeof RESTORABLE_FIELDS)[number];

export const FIELD_LABEL_AR: Record<string, string> = {
  title: "العنوان",
  slug: "الرابط",
  excerpt: "المقتطف",
  body: "النص",
  ai_summary: "الملخص",
  category_slug: "القسم",
  type: "النوع",
  cover_image_url: "الغلاف",
  cover_credit_name: "اعتماد الغلاف",
  cover_credit_url: "اعتماد الغلاف",
  source_name: "المصدر",
  source_url: "رابط المصدر",
  video_url: "رابط الفيديو",
};

const FLAG_LABEL_AR: Record<string, string> = { is_breaking: "عاجل", is_featured: "مميز" };

/** Distinct Arabic labels for a list of DB field names, in input order. */
export function fieldLabels(fields: readonly string[] | null | undefined): string[] {
  const out: string[] = [];
  for (const f of fields ?? []) {
    const l = FIELD_LABEL_AR[f] ?? f;
    if (!out.includes(l)) out.push(l);
  }
  return out;
}

/** Restorable fields whose snapshot value differs from the live row. */
export function changedRestorableFields(
  live: Record<string, unknown>,
  snap: Record<string, unknown>,
): RestorableField[] {
  return RESTORABLE_FIELDS.filter((f) => (live[f] ?? null) !== (snap[f] ?? null));
}

const statusAr = (s: string | null) => (s ? (STATUS_LABEL_AR[s] ?? s) : "");

/**
 * Arabic sentence parts for one audit event. `actor` is null when the sentence
 * stands alone (the seeded «imported» start-of-log marker).
 */
export function describeEvent(e: AuditEvent): {
  actor: string | null;
  text: string;
  transition: string | null;
  note: string | null;
} {
  const d = e.details ?? {};
  const fields = fieldLabels(d.fields);
  const withFields = fields.length ? ` (${fields.join("، ")})` : "";
  const alsoEdited = fields.length ? ` مع تعديل ${fields.join("، ")}` : "";
  const flags = (d.flags ?? []).map((f) => FLAG_LABEL_AR[f] ?? f);
  const transition =
    e.from_status && e.to_status ? `${statusAr(e.from_status)} ← ${statusAr(e.to_status)}` : null;
  const note = d.slug_changed_after_publish ? "تغيّر الرابط بعد النشر" : null;
  const actor = e.actor_name;

  switch (e.event) {
    case "imported":
      return { actor: null, text: "أُدرجت المادة في سجل النشاط — بداية السجل", transition: null, note: null };
    case "created":
      return { actor, text: "أنشأ المادة", transition: null, note };
    case "edited":
      return { actor, text: `عدّل المادة${withFields}`, transition: null, note };
    case "submitted":
      return { actor, text: `أرسل المادة للمراجعة${alsoEdited}`, transition: null, note };
    case "returned":
      return { actor, text: `أعاد المادة إلى المسودة${alsoEdited}`, transition, note };
    case "reviewed":
      return { actor, text: "راجع المادة", transition: null, note };
    case "published":
      return { actor, text: `نشر المادة${alsoEdited}`, transition: null, note };
    case "unpublished":
      return { actor, text: `ألغى نشر المادة${alsoEdited}`, transition: null, note };
    case "republished":
      return { actor, text: `أعاد نشر المادة${alsoEdited}`, transition, note };
    case "rejected":
      return { actor, text: `رفض المادة${alsoEdited}`, transition: null, note };
    case "deleted":
      return { actor, text: "نقل المادة إلى المحذوفات", transition: null, note };
    case "restored":
      return { actor, text: "استعاد المادة من المحذوفات", transition, note };
    case "version_restored":
      return {
        actor,
        text: d.restored_from != null ? `استعاد الإصدار رقم ${d.restored_from}` : "استعاد إصدارًا سابقًا",
        transition: null,
        note,
      };
    case "category_changed":
      return { actor, text: "غيّر القسم", transition: null, note };
    case "flag_changed":
      return {
        actor,
        text: flags.length ? `غيّر وسوم (${flags.join("، ")})` : "غيّر الوسوم",
        transition: null,
        note,
      };
    default:
      return { actor, text: e.event, transition, note };
  }
}

const absFmt = new Intl.DateTimeFormat("ar-KW", {
  day: "numeric",
  month: "long",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  numberingSystem: "latn",
  timeZone: "Asia/Kuwait",
});
const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuwait" });

/** Absolute Arabic date + time (Kuwait time, Western digits). */
export function absAr(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : absFmt.format(d);
}

/** True when two timestamps fall on the same Kuwait calendar day. */
export function sameDayKw(a: string, b: string): boolean {
  const da = new Date(a);
  const db = new Date(b);
  if (Number.isNaN(da.getTime()) || Number.isNaN(db.getTime())) return false;
  return dayFmt.format(da) === dayFmt.format(db);
}
