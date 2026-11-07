"use client";

// «تحرير بواسطة جمال» — universal Jamal action, rewrite entry point for an
// EXISTING article. Generates a proposal (no write), shows it beside the
// current text with Jamal's internal notes, and applies it only on the
// editor's explicit acceptance; the previous text is preserved automatically
// by the content version history. The «تحرير جمال» badge appears only after
// acceptance (provenance is linked then, never at proposal time).
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  acceptJamalRewrite,
  jamalRewriteProposal,
  type JamalRewriteResult,
} from "@/app/admin/jamal-actions";
import JamalBadge from "./JamalBadge";

type Proposal = Extract<JamalRewriteResult, { ok: true }>;

export default function JamalRewritePanel({
  contentId,
  autoOpen,
}: {
  contentId: string;
  autoOpen?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(!!autoOpen);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[] | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [pending, startTransition] = useTransition();

  function generate() {
    setError(null);
    setNotes(null);
    setProposal(null);
    setAccepted(false);
    startTransition(async () => {
      const res = await jamalRewriteProposal(contentId);
      if ("ok" in res) setProposal(res);
      else {
        setError(res.error);
        if (res.reviewNotes?.length) setNotes(res.reviewNotes);
      }
    });
  }

  function accept() {
    if (!proposal) return;
    setError(null);
    startTransition(async () => {
      const res = await acceptJamalRewrite({
        contentId,
        proposal: proposal.proposal,
        jamalRunId: proposal.jamalRunId,
        baseVersion: proposal.baseVersion,
      });
      if ("ok" in res) {
        setAccepted(true);
        setProposal(null);
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  return (
    <div className="mb-5 max-w-2xl rounded-2xl border border-line bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-[14px] font-bold">إعادة الصياغة</h2>
          <JamalBadge />
        </div>
        {!open ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded-lg border border-line bg-white px-3 py-1.5 text-[12.5px] font-semibold text-teal hover:bg-cream"
          >
            تحرير بواسطة جمال
          </button>
        ) : null}
      </div>

      {open ? (
        <div className="mt-3">
          {!proposal && !accepted ? (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={pending}
                onClick={generate}
                className="rounded-lg bg-teal px-4 py-2 text-[13px] font-bold text-white disabled:opacity-50"
              >
                {pending ? "جمال يكتب…" : "توليد صياغة مقترحة"}
              </button>
              <span className="font-sans text-[12px] text-gray">
                لا يتغيّر المقال إلا بعد اعتمادك للاقتراح. قد يستغرق التوليد دقيقة
                أو دقيقتين.
              </span>
            </div>
          ) : null}

          {accepted ? (
            <p className="mt-2 font-sans text-[12.5px] font-semibold text-teal">
              اعتُمدت الصياغة الجديدة. النص السابق محفوظ في «الإصدارات» ويمكن
              استعادته.
            </p>
          ) : null}

          {error ? <p className="mt-2 font-sans text-[12.5px] font-semibold text-coral">{error}</p> : null}
          {notes?.length ? (
            <ul className="mt-2 list-disc pr-5 font-sans text-[12px] text-gray">
              {notes.map((n, i) => <li key={i}>{n}</li>)}
            </ul>
          ) : null}

          {proposal ? (
            <div className="mt-3 rounded-xl border border-line bg-cream/40 p-3">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="rounded-md bg-blue/10 px-2 py-0.5 font-sans text-[11px] font-bold text-blue">
                  صياغة مقترحة — غير محفوظة
                </span>
                {proposal.grounding === "stored_body" ? (
                  <span className="rounded-md bg-coral/10 px-2 py-0.5 font-sans text-[11px] font-bold text-coral">
                    استناداً إلى نص المقال الحالي فقط
                  </span>
                ) : (
                  <span className="rounded-md bg-teal/10 px-2 py-0.5 font-sans text-[11px] font-bold text-teal">
                    أعيد التحقق من المصدر الأصلي
                  </span>
                )}
                {proposal.needsHumanReview ? (
                  <span className="rounded-md bg-coral/10 px-2 py-0.5 font-sans text-[11px] font-bold text-coral">
                    يتطلب انتباه المراجع
                  </span>
                ) : null}
              </div>
              <div className="mb-1.5 text-[15px] font-bold">{proposal.proposal.title}</div>
              {proposal.proposal.excerpt ? (
                <div className="mb-2 font-sans text-[12.5px] text-gray">{proposal.proposal.excerpt}</div>
              ) : null}
              <div className="salma-scroll max-h-80 overflow-y-auto whitespace-pre-wrap text-[13.5px] leading-relaxed">
                {proposal.proposal.body}
              </div>
              {proposal.proposal.review_notes.length ? (
                <div className="mt-3 border-t border-line pt-2">
                  <div className="mb-1 font-sans text-[11.5px] font-bold text-gray">ملاحظات جمال الداخلية (ليست للنشر)</div>
                  <ul className="list-disc pr-5 font-sans text-[12px] text-gray">
                    {proposal.proposal.review_notes.map((n, i) => <li key={i}>{n}</li>)}
                  </ul>
                </div>
              ) : null}
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={pending}
                  onClick={accept}
                  className="rounded-lg bg-teal px-4 py-2 text-[13px] font-bold text-white disabled:opacity-50"
                >
                  اعتماد الصياغة
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => setProposal(null)}
                  className="rounded-lg border border-line bg-white px-4 py-2 text-[13px] font-semibold text-gray hover:bg-cream disabled:opacity-50"
                >
                  تجاهل
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={generate}
                  className="rounded-lg border border-line bg-white px-4 py-2 text-[13px] font-semibold text-gray hover:bg-cream disabled:opacity-50"
                >
                  إعادة التوليد
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
