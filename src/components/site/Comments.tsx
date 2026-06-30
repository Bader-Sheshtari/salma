"use client";

import { useActionState } from "react";
import { submitComment, type CommentResult } from "@/app/actions/comments";
import type { Comment } from "@/lib/queries";
import { timeAgoAr } from "@/lib/format";

export function Comments({
  contentId,
  comments,
}: {
  contentId: string;
  comments: Comment[];
}) {
  const [state, formAction, pending] = useActionState<CommentResult | null, FormData>(
    submitComment,
    null,
  );

  return (
    <section className="mt-8">
      <div className="mb-3.5 flex items-center gap-2.5">
        <span className="h-[22px] w-1 rounded-sm bg-teal" />
        <h2 className="text-[17px] font-bold">التعليقات ({comments.length})</h2>
      </div>

      {state?.ok ? (
        <div className="mb-4 rounded-lg bg-cream px-4 py-3 text-[13px] text-teal">
          تم استلام تعليقك وسيظهر بعد مراجعته من المحرّر.
        </div>
      ) : (
        <form action={formAction} className="mb-6 rounded-2xl border border-line p-4">
          <input type="hidden" name="content_id" value={contentId} />
          <input
            name="author_name"
            placeholder="اسمك"
            dir="rtl"
            required
            className="mb-2.5 w-full rounded-lg border border-gray/40 px-3.5 py-2.5 text-sm outline-none focus:border-teal"
          />
          <textarea
            name="body"
            placeholder="اكتب تعليقك…"
            dir="rtl"
            rows={3}
            required
            className="mb-1 w-full resize-y rounded-lg border border-gray/40 px-3.5 py-2.5 text-sm outline-none focus:border-teal"
          />
          {state && !state.ok ? (
            <div className="mb-2 text-[12.5px] text-coral">{state.error}</div>
          ) : null}
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] text-gray">تُراجَع التعليقات قبل نشرها.</span>
            <button
              type="submit"
              disabled={pending}
              className="rounded-lg bg-teal px-5 py-2.5 text-[13px] font-bold text-white disabled:opacity-60"
            >
              {pending ? "جارٍ الإرسال…" : "أرسل التعليق"}
            </button>
          </div>
        </form>
      )}

      <div className="flex flex-col gap-3">
        {comments.length === 0 ? (
          <div className="text-[13px] text-gray">كن أول من يعلّق.</div>
        ) : (
          comments.map((c) => (
            <div key={c.id} className="rounded-xl border border-line p-3.5">
              <div className="flex items-center justify-between">
                <span className="text-[13.5px] font-bold">{c.author_name}</span>
                <span className="font-sans text-[11px] text-gray">{timeAgoAr(c.created_at)}</span>
              </div>
              <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink">{c.body}</p>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
