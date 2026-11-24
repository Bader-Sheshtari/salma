"use client";

import { useId, useState, type CSSProperties, type KeyboardEvent } from "react";
import {
  BRAND_FAMILIES,
  DAWI_COLORS,
  DAWI_KEYS,
  DAWI_SHADES,
  FAMILY_KEYS,
  TINT_STEPS,
  hostsText,
  type DawiKey,
  type DawiShade,
  type FamilyKey,
  type TintStep,
} from "@/lib/brandPalette";
import {
  FAMILY_DEFAULTS,
  accentFor,
  dawiAccent,
  identityFor,
  offeredDawiShades,
  parseAccent,
  type IdentityKey,
} from "@/lib/sectionIdentity";

/**
 * Section identity picker (owner-approved family × tint grammar). Writes the
 * accent value into a hidden `name` input so the existing server action is
 * untouched. Choosing a family's DEFAULT writes the bare family key, which for
 * the refined-H1 families resolves to their frozen legacy recipe.
 *
 * Accessibility: families and tints are radiogroups (arrow keys move the
 * selection, RTL-aware); every swatch carries its name/step and hex as text —
 * colour is never the only information.
 */

type Choice = {
  family: FamilyKey | null;
  tint: TintStep | "rule" | null;
  dawi?: DawiKey | null;
  shade?: DawiShade | "rule" | null;
};

/** Legacy keys → the family/tint they correspond to (for highlighting). */
const LEGACY_CHOICE: Record<IdentityKey, Choice> = {
  paper: { family: null, tint: null },
  "frost-rule": { family: "frost", tint: "rule" },
  teal: { family: "teal", tint: FAMILY_DEFAULTS.teal },
  pink: { family: "pink", tint: FAMILY_DEFAULTS.pink },
  jet: { family: "jet", tint: FAMILY_DEFAULTS.jet },
  frost: { family: "frost", tint: FAMILY_DEFAULTS.frost },
  mauve: { family: "mauve", tint: FAMILY_DEFAULTS.mauve },
  wine: { family: "wine", tint: FAMILY_DEFAULTS.wine },
  vanilla: { family: "vanilla", tint: FAMILY_DEFAULTS.vanilla },
};

function choiceOf(value: string): Choice {
  const p = parseAccent(value);
  if (p.kind === "paper") return { family: null, tint: null };
  if (p.kind === "legacy") return LEGACY_CHOICE[p.key];
  if (p.kind === "dawi") return { family: null, tint: null, dawi: p.color, shade: p.shade };
  return { family: p.family, tint: p.tint };
}

const accentValue = accentFor;

/** Arrow-key navigation inside a radiogroup (RTL: ArrowLeft = next). */
function onRadioKeys(e: KeyboardEvent<HTMLDivElement>) {
  const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
  if (!keys.includes(e.key)) return;
  const radios = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]:not([disabled])')];
  const i = radios.indexOf(document.activeElement as HTMLButtonElement);
  if (i < 0 || radios.length === 0) return;
  e.preventDefault();
  const rtl = getComputedStyle(e.currentTarget).direction === "rtl";
  const next =
    e.key === "Home"
      ? 0
      : e.key === "End"
        ? radios.length - 1
        : e.key === "ArrowDown" || e.key === (rtl ? "ArrowLeft" : "ArrowRight")
          ? (i + 1) % radios.length
          : (i - 1 + radios.length) % radios.length;
  radios[next].focus();
  radios[next].click();
}

const swatchBtn =
  "flex min-h-11 items-center gap-2 rounded-lg border px-2 py-1.5 text-start text-[13px] focus-visible:outline-2 focus-visible:outline-offset-2";

export function AccentPicker({ name, defaultValue }: { name: string; defaultValue: string }) {
  const [value, setValue] = useState(defaultValue);
  const [advanced, setAdvanced] = useState(false);
  const uid = useId();
  const choice = choiceOf(value);
  const legacyRaw =
    value.trim() !== "" && value.trim().toLowerCase() !== "paper" && choice.family === null && !choice.dawi;
  const fam = choice.family ? BRAND_FAMILIES[choice.family] : null;
  const dawi = choice.dawi ? DAWI_COLORS[choice.dawi] : null;
  const idn = identityFor(value);

  return (
    <div className="flex flex-col gap-3 text-[13px] text-ink">
      <input type="hidden" name={name} value={value} />

      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">هوية القسم (اللون)</span>
        {legacyRaw ? (
          <span className="rounded-full bg-cream px-2.5 py-1 text-[12px] font-semibold text-ink">
            قيمة قديمة — تُعرض ورقية <span dir="ltr" className="font-mono">({value})</span>
          </span>
        ) : null}
      </div>

      {/* Families */}
      <div
        role="radiogroup"
        aria-label="عائلة اللون"
        onKeyDown={onRadioKeys}
        className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4"
      >
        <button
          type="button"
          role="radio"
          aria-checked={choice.family === null && !choice.dawi && !legacyRaw}
          tabIndex={choice.family === null && !choice.dawi ? 0 : -1}
          onClick={() => setValue("")}
          className={`${swatchBtn} ${choice.family === null && !choice.dawi && !legacyRaw ? "border-ink ring-2 ring-ink" : "border-line"}`}
        >
          <span aria-hidden className="size-7 shrink-0 rounded-md border border-line" style={{ background: "#FCFAF9" }} />
          <span>
            ورقي (افتراضي آمن)
            <span dir="ltr" className="block font-mono text-[12px] text-gray">paper</span>
          </span>
        </button>
        {FAMILY_KEYS.map((k) => {
          const f = BRAND_FAMILIES[k];
          const on = choice.family === k;
          return (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              onClick={() => {
                const d = FAMILY_DEFAULTS[k];
                setValue(accentValue(k, d));
              }}
              className={`${swatchBtn} ${on ? "border-ink ring-2 ring-ink" : "border-line"}`}
            >
              <span aria-hidden className="size-7 shrink-0 rounded-md border border-line" style={{ background: f.tints[100] }} />
              <span>
                {f.ar}
                <span dir="ltr" className="block font-mono text-[12px] text-gray">
                  {f.en} · {f.tints[100]}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {/* Tints of the selected family */}
      {fam ? (
        <div
          role="radiogroup"
          aria-label={`درجات ${fam.ar}`}
          onKeyDown={onRadioKeys}
          className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6"
        >
          {TINT_STEPS.map((t) => {
            const hex = fam.tints[t];
            const ok = hostsText(hex);
            const on = choice.tint === t;
            const isDefault = FAMILY_DEFAULTS[fam.key] === t;
            return (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={!ok}
                tabIndex={on ? 0 : -1}
                onClick={() => setValue(accentValue(fam.key, t))}
                title={ok ? undefined : "لا تستضيف نصاً مقروءاً — متاحة كخط فقط"}
                className={`${swatchBtn} disabled:cursor-not-allowed disabled:opacity-50 ${
                  on ? "border-ink ring-2 ring-ink" : "border-line"
                }`}
              >
                <span aria-hidden className="size-7 shrink-0 rounded-md border border-line" style={{ background: hex }} />
                <span>
                  {t}
                  {isDefault ? <span className="ms-1 rounded bg-cream px-1 text-[12px] font-bold">الافتراضي</span> : null}
                  <span dir="ltr" className="block font-mono text-[12px] text-gray">{hex}</span>
                  {!ok ? <span className="block text-[12px] text-gray">خط فقط</span> : null}
                </span>
              </button>
            );
          })}
          <button
            type="button"
            role="radio"
            aria-checked={choice.tint === "rule"}
            tabIndex={choice.tint === "rule" ? 0 : -1}
            onClick={() => setValue(accentValue(fam.key, "rule"))}
            className={`${swatchBtn} ${choice.tint === "rule" ? "border-ink ring-2 ring-ink" : "border-line"}`}
          >
            <span aria-hidden className="relative size-7 shrink-0 rounded-md border border-line bg-[#FCFAF9]">
              <span className="absolute inset-x-1 top-3 h-[3px]" style={{ background: fam.tints[100] }} />
            </span>
            <span>
              خط فقط (ورق)
              {FAMILY_DEFAULTS[fam.key] === "rule" ? (
                <span className="ms-1 rounded bg-cream px-1 text-[12px] font-bold">الافتراضي</span>
              ) : null}
              <span dir="ltr" className="block font-mono text-[12px] text-gray">{fam.key}-rule</span>
            </span>
          </button>
        </div>
      ) : null}

      {/* DAWI brand colors — a separate collection (documented pairs, no tint
          scale; Bandage is logo-only and deliberately absent). Never applied
          automatically: selectable for any section, like any other identity. */}
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <span className="font-semibold">ألوان داوي (مجموعة منفصلة)</span>
        <span className="text-[12px] text-gray">درجتان رسميتان لكل لون — لا تُطبّق تلقائياً على أي قسم</span>
      </div>
      <div
        role="radiogroup"
        aria-label="ألوان داوي"
        onKeyDown={onRadioKeys}
        className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4"
      >
        {DAWI_KEYS.map((k) => {
          const c = DAWI_COLORS[k];
          const on = choice.dawi === k;
          return (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              onClick={() => {
                const shades = offeredDawiShades(k);
                setValue(dawiAccent(k, shades[0] ?? "rule"));
              }}
              className={`${swatchBtn} ${on ? "border-ink ring-2 ring-ink" : "border-line"}`}
            >
              <span
                aria-hidden
                className="size-7 shrink-0 rounded-md border border-line"
                style={{ background: c.shades.primary }}
              />
              <span>
                {c.ar}
                <span dir="ltr" className="block font-mono text-[12px] text-gray">
                  {c.en} · {c.shades.primary}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {/* Shades of the selected DAWI color */}
      {dawi ? (
        <div
          role="radiogroup"
          aria-label={`درجات ${dawi.ar}`}
          onKeyDown={onRadioKeys}
          className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6"
        >
          {DAWI_SHADES.map((s) => {
            const hex = dawi.shades[s];
            const ok = hostsText(hex);
            const on = choice.shade === s;
            return (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={!ok}
                tabIndex={on ? 0 : -1}
                onClick={() => setValue(dawiAccent(dawi.key, s))}
                title={ok ? undefined : "لا تستضيف نصاً مقروءاً — متاحة كخط فقط"}
                className={`${swatchBtn} disabled:cursor-not-allowed disabled:opacity-50 ${
                  on ? "border-ink ring-2 ring-ink" : "border-line"
                }`}
              >
                <span aria-hidden className="size-7 shrink-0 rounded-md border border-line" style={{ background: hex }} />
                <span>
                  {dawi.labels[s]}
                  <span dir="ltr" className="block font-mono text-[12px] text-gray">{hex}</span>
                  {!ok ? <span className="block text-[12px] text-gray">خط فقط</span> : null}
                </span>
              </button>
            );
          })}
          <button
            type="button"
            role="radio"
            aria-checked={choice.shade === "rule"}
            tabIndex={choice.shade === "rule" ? 0 : -1}
            onClick={() => setValue(dawiAccent(dawi.key, "rule"))}
            className={`${swatchBtn} ${choice.shade === "rule" ? "border-ink ring-2 ring-ink" : "border-line"}`}
          >
            <span aria-hidden className="relative size-7 shrink-0 rounded-md border border-line bg-[#FCFAF9]">
              <span className="absolute inset-x-1 top-3 h-[3px]" style={{ background: dawi.shades.primary }} />
            </span>
            <span>
              خط فقط (ورق)
              <span dir="ltr" className="block font-mono text-[12px] text-gray">{dawiAccent(dawi.key, "rule")}</span>
            </span>
          </button>
        </div>
      ) : null}

      {/* Live preview — the same identity module the homepage renders with */}
      <div aria-label="معاينة الهوية" role="group" className="overflow-hidden rounded-xl border border-line">
        <div
          className={`${idn.ink} ${idn.field ? idn.surface : "bg-[#FCFAF9]"} px-4 py-5`}
          style={idn.vars as CSSProperties | undefined}
        >
          <div className="mb-4 flex items-center gap-3">
            <span className={`text-lg font-bold ${idn.ink}`}>عنوان القسم</span>
            <span aria-hidden className="flex flex-1 items-center">
              <span className={`h-[3px] w-7 shrink-0 ${idn.rule}`} />
              <span className={`h-px flex-1 ${idn.ruleLine}`} />
            </span>
          </div>
          <div className={`grid grid-cols-[48px_minmax(0,1fr)] gap-3 border-b pb-3 ${idn.hairline}`}>
            <span aria-hidden className={`size-12 rounded-xl ${idn.fieldTile}`} />
            <div>
              <div className={`text-base font-semibold ${idn.headline}`}>عنوان خبر تجريبي على هذا السطح</div>
              <p className={`mt-1 text-sm ${idn.body}`}>مقتطف قصير يوضح لون النص الثانوي ومدى وضوحه.</p>
              <p className={`mt-2 flex items-center gap-1.5 text-[13px] ${idn.body}`}>
                <span className={`rounded-full px-2 py-0.5 ${idn.pillText} ${idn.pill}`}>3 دقائق قراءة</span>
              </p>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3 text-[13px]">
            <span
              aria-hidden
              className={`grid size-10 place-items-center rounded-full font-bold text-amethyst ${idn.disc ?? "bg-amethyst-100"}`}
            >
              01
            </span>
            {idn.drop ? <span className={`border-s-[3px] ps-2 ${idn.drop} ${idn.body}`}>خط جانبي</span> : null}
            <span dir="ltr" className={`font-mono ${idn.body}`}>
              {idn.key}
            </span>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          aria-expanded={advanced}
          aria-controls={`${uid}-adv`}
          onClick={() => setAdvanced((a) => !a)}
          className="min-h-11 rounded-lg border border-line px-3 text-[13px] font-semibold"
        >
          {advanced ? "إخفاء الإدخال المتقدم" : "إدخال متقدم (نص حر)"}
        </button>
        <span className="text-[12px] text-gray">تسري الاختيارات على الموقع فقط بعد نشر الكود الجديد.</span>
      </div>
      {advanced ? (
        <label id={`${uid}-adv`} className="block text-[12px] font-semibold text-gray">
          قيمة الهوية (مثال: teal ، golden-30 ، jet-rule ، dawi-teal-light)
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            dir="ltr"
            className="mt-1 w-full rounded-lg border border-gray/40 bg-white px-3 py-2 text-sm outline-none focus:border-teal"
          />
        </label>
      ) : null}
    </div>
  );
}
