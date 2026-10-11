import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { getDevelopmentState } from "@/app/admin/develop-actions";
import { DevelopFlow } from "../../../content/[id]/develop/DevelopFlow";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Props = { params: Promise<{ key: string }>; searchParams: Promise<{ t?: string }> };

/**
 * Develop Story from a RADAR CLUSTER (V2): the cluster's reports are leads
 * only — every source still passes the authoritative-source and evidence
 * logic before anything can be cited. Radar itself is read-only here.
 * Admin-gated like the rest of the Radar area.
 */
export default async function DevelopClusterPage({ params, searchParams }: Props) {
  await requireAdmin();
  const { key } = await params;
  const { t } = await searchParams;
  const clusterKey = decodeURIComponent(key);
  const title = (t ?? "").slice(0, 200) || null;

  const initial = await getDevelopmentState({ type: "cluster", key: clusterKey });

  return (
    <div className="max-w-3xl">
      <div className="mb-1 font-sans text-[12px] text-gray">
        <Link href="/admin/radar" className="hover:text-ink">
          ← العودة إلى رادار الأخبار
        </Link>
      </div>
      <h1 className="mb-4 text-2xl font-bold">طوّر القصة من الرادار</h1>

      <div className="mb-5 rounded-2xl border border-line bg-white p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-md bg-teal/10 px-2 py-0.5 text-[11px] font-bold text-teal">
            قصة من رادار سلمى
          </span>
        </div>
        {title ? <div className="mt-2 text-[15px] font-bold leading-snug">{title}</div> : null}
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-gray">
          تُعامل تقارير الرادار كخيوط أولية فقط — تبحث سلمى عن المصادر الرسمية والأولية وتتحقق من
          كل دليل قبل إعداد موجز البحث.
        </p>
      </div>

      <DevelopFlow
        origin={{ type: "cluster", key: clusterKey, title }}
        initialJob={initial.job}
        initialHistory={initial.history}
        initialResultTitle={initial.resultTitle}
      />
    </div>
  );
}
