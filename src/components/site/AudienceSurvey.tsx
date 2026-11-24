"use client";

import { useActionState, useMemo, useState } from "react";
import { submitAudienceSurvey, type SurveyResult } from "@/app/actions/newsletter";
import {
  CONTENT_OPTIONS,
  COUNTRY_CODES,
  FREQUENCY_OPTIONS,
  GCC_CODES,
  PREFER_NOT_SAY,
  PROFESSION_OPTIONS,
  REASON_OPTIONS,
  TOPIC_OPTIONS,
  type Option,
} from "@/lib/newsletter";

/**
 * Optional audience survey shown AFTER a subscription has already succeeded.
 * Every question is individually optional; skipping (or submitting nothing)
 * leaves the subscription fully intact.
 */

function Chip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`min-h-11 rounded-full border px-4 py-2 text-[13px] font-semibold transition-colors ${
        active
          ? "border-amethyst bg-amethyst text-white"
          : "border-hairline-strong bg-white text-amethyst hover:border-amethyst"
      }`}
    >
      {label}
    </button>
  );
}

function MultiChips({
  name,
  options,
  selected,
  toggle,
}: {
  name: string;
  options: Option[];
  selected: Set<string>;
  toggle: (key: string) => void;
}) {
  return (
    <div className="flex flex-wrap justify-center gap-1.5">
      {options.map((o) => (
        <Chip key={o.key} label={o.label} active={selected.has(o.key)} onClick={() => toggle(o.key)} />
      ))}
      {[...selected].map((k) => (
        <input key={k} type="hidden" name={name} value={k} />
      ))}
    </div>
  );
}

function SingleChips({
  name,
  options,
  value,
  setValue,
}: {
  name: string;
  options: Option[];
  value: string | null;
  setValue: (v: string | null) => void;
}) {
  return (
    <div className="flex flex-wrap justify-center gap-1.5">
      {options.map((o) => (
        <Chip
          key={o.key}
          label={o.label}
          active={value === o.key}
          onClick={() => setValue(value === o.key ? null : o.key)}
        />
      ))}
      {value ? <input type="hidden" name={name} value={value} /> : null}
    </div>
  );
}

function Question({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-5">
      <div className="mb-2 text-sm font-bold text-amethyst">{title}</div>
      {children}
    </div>
  );
}

export function AudienceSurvey({ token }: { token: string }) {
  const [state, formAction, pending] = useActionState<SurveyResult | null, FormData>(
    submitAudienceSurvey,
    null,
  );
  const [skipped, setSkipped] = useState(false);

  const [profession, setProfession] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Set<string>>(new Set());
  const [topics, setTopics] = useState<Set<string>>(new Set());
  const [prefs, setPrefs] = useState<Set<string>>(new Set());
  const [frequency, setFrequency] = useState<string | null>(null);

  const toggler = (set: Set<string>, update: (s: Set<string>) => void) => (key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    update(next);
  };

  // Arabic country names from the runtime — no maintained name list. GCC
  // pinned first (Kuwait on top), everyone else alphabetically; no restriction.
  const countries = useMemo(() => {
    const names = new Intl.DisplayNames(["ar"], { type: "region" });
    const label = (c: string) => names.of(c) ?? c;
    const gcc = [...GCC_CODES];
    const rest = COUNTRY_CODES.filter((c) => !GCC_CODES.includes(c as (typeof GCC_CODES)[number]))
      .map((c) => ({ code: c, name: label(c) }))
      .sort((a, b) => a.name.localeCompare(b.name, "ar"));
    return [...gcc.map((c) => ({ code: c, name: label(c) })), ...rest];
  }, []);

  if (skipped) return null;

  if (state?.ok) {
    return (
      <div className="mt-4 rounded-lg bg-white px-4 py-3 text-[13px] text-amethyst">
        {state.saved ? "شكراً لك! تم حفظ إجاباتك." : "تم التخطي — اشتراكك في النشرة قائم."}
      </div>
    );
  }

  const selectClass =
    "min-h-11 w-full max-w-xs rounded-lg border border-hairline-strong bg-white px-3 py-2.5 text-sm text-amethyst outline-none focus:border-amethyst";

  return (
    <div className="mt-5 rounded-2xl border border-hairline bg-white p-5 text-start text-amethyst sm:p-6">
      <div className="flex flex-wrap items-center justify-center gap-2">
        <span className="rounded-full bg-mauve-20 px-2.5 py-1 text-[13px] font-bold text-amethyst md:text-xs">
          اختياري
        </span>
      </div>
      <p className="mt-3 text-center text-[13px] leading-relaxed text-amethyst-600">
        إذا حاب، جاوب على كم سؤال اختياري يساعدنا نفهم اهتمامات جمهور سلمى بشكل أفضل ونقدم محتوى
        أقرب لما يفيدك فعلاً.
      </p>
      <p className="mt-2 text-center text-[13px] leading-relaxed text-amethyst-600 md:text-xs">
        تساعدنا هذه المعلومات على فهم جمهور سلمى واهتماماته بشكل أفضل، حتى نطور المحتوى والنشرات
        والخدمات المستقبلية ونقدم ما هو أكثر فائدة وملاءمة لقرائنا. جميع هذه الأسئلة اختيارية ولا
        تؤثر على اشتراكك في النشرة.
      </p>

      <form action={formAction} className="text-center">
        <input type="hidden" name="token" value={token} />

        <Question title="هل أنت طبيب أو تعمل في القطاع الصحي؟">
          <SingleChips
            name="profession"
            options={PROFESSION_OPTIONS}
            value={profession}
            setValue={setProfession}
          />
        </Question>

        <Question title="ليش تهتم بالمحتوى الصحي والطبي؟">
          <MultiChips
            name="reasons"
            options={REASON_OPTIONS}
            selected={reasons}
            toggle={toggler(reasons, setReasons)}
          />
          {reasons.has("other") ? (
            <input
              type="text"
              name="reason_other"
              dir="rtl"
              maxLength={280}
              placeholder="اذكر السبب (اختياري)"
              className="mt-2 min-h-11 w-full max-w-xs rounded-lg border border-hairline-strong bg-white px-3 py-2 text-sm text-amethyst outline-none placeholder:text-amethyst-600 focus:border-amethyst"
            />
          ) : null}
        </Question>

        <Question title="ما المواضيع التي تهمك أكثر؟">
          <MultiChips
            name="topics"
            options={TOPIC_OPTIONS}
            selected={topics}
            toggle={toggler(topics, setTopics)}
          />
        </Question>

        <Question title="أي نوع من المحتوى تفضله؟">
          <MultiChips
            name="content_preferences"
            options={CONTENT_OPTIONS}
            selected={prefs}
            toggle={toggler(prefs, setPrefs)}
          />
        </Question>

        <Question title="كم مرة تفضل أن توصلك النشرة؟">
          <SingleChips
            name="frequency"
            options={FREQUENCY_OPTIONS}
            value={frequency}
            setValue={setFrequency}
          />
        </Question>

        <Question title="أين تقيم؟">
          <select name="residence" dir="rtl" defaultValue="" className={selectClass}>
            <option value="">— اختر الدولة (اختياري) —</option>
            {countries.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </select>
        </Question>

        <Question title="الجنسية">
          <select name="nationality" dir="rtl" defaultValue="" className={selectClass}>
            <option value="">— اختر الجنسية (اختياري) —</option>
            <option value={PREFER_NOT_SAY}>أفضل عدم الإجابة</option>
            {countries.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </select>
        </Question>

        {state && !state.ok ? (
          <div className="mt-4 text-[13px] text-wine-plum">{state.error}</div>
        ) : null}

        <div className="mt-6 flex items-center justify-center gap-2">
          <button
            type="submit"
            disabled={pending}
            className="min-h-11 rounded-full bg-amethyst px-6 py-2.5 text-sm font-bold text-white hover:bg-amethyst-800 disabled:opacity-60"
          >
            {pending ? "…" : "حفظ الإجابات"}
          </button>
          <button
            type="button"
            onClick={() => setSkipped(true)}
            className="min-h-11 rounded-full border border-hairline-strong bg-white px-6 py-2.5 text-sm font-semibold text-amethyst hover:border-amethyst"
          >
            تخطي
          </button>
        </div>
      </form>
    </div>
  );
}
