import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { getNewsletterIssue, listIssueContentLinks } from "@/lib/admin-queries";
import IssueEditor from "./IssueEditor";

export const dynamic = "force-dynamic";

// Newsletter Curation Engine V1 — single-issue editor (brief §25, §31).
export default async function NewsletterIssuePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireStaff();
  const { id } = await params;
  const data = await getNewsletterIssue(id);
  if (!data) notFound();
  const contentLinks = await listIssueContentLinks(data.items.map((i) => i.content_id));
  return <IssueEditor issue={data.issue} items={data.items} contentLinks={contentLinks} />;
}
