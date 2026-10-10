// AFTER THE NEWS / DEVELOP STORY — pure research-brief + direction module.
//
// No I/O, no env: prompt builders, the strict brief JSON schema, bounded
// parsing/validation, and the Arabic writing-overlay for the development
// draft. The orchestration (fetching, escalation, evidence, model calls,
// persistence) lives in develop-story/index.ts on top of the shared
// ingest-news pipeline modules.

export const BRIEF_PROMPT_VERSION = "ds1" as const;

// ---- Development directions -------------------------------------------------
//
// Keys are the contract shared with the admin UI (src/lib/develop-story.ts)
// and the story_developments.direction CHECK constraint — change all three
// together.
export type DevelopmentDirection =
  | "deeper_explainer"
  | "behind_the_news"
  | "evidence_analysis"
  | "context_background"
  | "reader_impact"
  | "follow_up"
  | "auto";

export const DIRECTIONS: Record<
  Exclude<DevelopmentDirection, "auto">,
  { label: string; writerGoal: string }
> = {
  deeper_explainer: {
    label: "شرح أعمق للخبر",
    writerGoal:
      "اشرح الخبر بعمق أكبر: ما الذي حدث فعلاً، وكيف يعمل، وما التفاصيل التي تجعل القارئ يفهمه فهماً حقيقياً لا سطحياً.",
  },
  behind_the_news: {
    label: "ما وراء الخبر",
    writerGoal:
      "اكشف ما وراء الخبر: من أعلن ولماذا الآن، وما الذي لا يظهر في الصياغة الأصلية، وما الفرق بين ما قيل وما تدعمه المصادر والأدلة.",
  },
  evidence_analysis: {
    label: "تحليل الأدلة العلمية",
    writerGoal:
      "حلّل الأدلة العلمية المتاحة: نوع الدراسة وحجم العيّنة وقوة الدليل، وهل الادّعاء أقوى من الدليل، والفرق بين الارتباط والسببية، وحدود ما يمكن استنتاجه.",
  },
  context_background: {
    label: "السياق والخلفية",
    writerGoal:
      "قدّم السياق والخلفية: ما الذي سبق هذا الخبر، وما الذي كان معروفاً من قبل، وما الجديد فيه تحديداً، وكيف يتصل بتطورات سابقة.",
  },
  reader_impact: {
    label: "ماذا يعني هذا للقارئ؟",
    writerGoal:
      "ركّز على معنى الخبر للقارئ: من يتأثر به عملياً، وما الذي يتغيّر (أو لا يتغيّر) في حياته، وما الذي يجب أن يفهمه دون تهويل أو نصائح طبية تتجاوز المصادر.",
  },
  follow_up: {
    label: "متابعة التطورات",
    writerGoal:
      "تابع تطوّر القصة: ما الذي استجد منذ الخبر الأصلي، وما المراحل أو القرارات المنتظرة، وما الذي يجب مراقبته لاحقاً.",
  },
};

export function isDirection(v: unknown): v is DevelopmentDirection {
  return typeof v === "string" && (v === "auto" || v in DIRECTIONS);
}

// ---- Research brief shape ---------------------------------------------------

export type BriefAngle = {
  direction: Exclude<DevelopmentDirection, "auto">;
  title: string;
  rationale: string;
  recommended: boolean;
};

export type ResearchBrief = {
  story_summary: string;
  new_vs_known: string;
  evidence_says: string;
  key_numbers: { value: string; context: string }[];
  known: string[];
  unknown: string[];
  uncertain_claims: string[];
  suggested_angles: BriefAngle[];
};

const DIRECTION_KEYS = Object.keys(DIRECTIONS);

export const BRIEF_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "salma_research_brief",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: [
        "story_summary",
        "new_vs_known",
        "evidence_says",
        "key_numbers",
        "known",
        "unknown",
        "uncertain_claims",
        "suggested_angles",
      ],
      properties: {
        story_summary: { type: "string" },
        new_vs_known: { type: "string" },
        evidence_says: { type: "string" },
        key_numbers: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["value", "context"],
            properties: { value: { type: "string" }, context: { type: "string" } },
          },
        },
        known: { type: "array", items: { type: "string" } },
        unknown: { type: "array", items: { type: "string" } },
        uncertain_claims: { type: "array", items: { type: "string" } },
        suggested_angles: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["direction", "title", "rationale", "recommended"],
            properties: {
              direction: { type: "string", enum: DIRECTION_KEYS },
              title: { type: "string" },
              rationale: { type: "string" },
              recommended: { type: "boolean" },
            },
          },
        },
      },
    },
  },
} as const;

// ---- Brief prompt -------------------------------------------------------------

export function buildBriefMessages(input: {
  original: {
    title: string;
    excerpt: string | null;
    body: string;
    categorySlug: string | null;
    publishedAt: string | null;
    sourceName: string | null;
    sourceUrl: string | null;
  };
  // Verified fetched texts (may be empty strings when a fetch failed).
  originalSourceText: string;
  primarySourceText: string;
  primarySourceUrl: string | null;
  evidenceCardJson: string | null;
  relatedItems: { title: string; publishedAt: string | null }[];
  requestedDirection: DevelopmentDirection;
  editorNote: string | null;
}): { role: string; content: string }[] {
  const dirLabel = input.requestedDirection === "auto"
    ? "لم يحدد المحرر اتجاهاً — اقترح الاتجاه الأنسب"
    : DIRECTIONS[input.requestedDirection].label;

  const system = [
    `أنت باحث تحريري في منصة «سلمى» الصحية. مهمتك إعداد «موجز بحث» تحريري دقيق يساعد المحرر على تطوير خبر منشور إلى مادة أعمق. (إصدار التعليمات: ${BRIEF_PROMPT_VERSION})`,
    "",
    "قواعد صارمة غير قابلة للتجاوز:",
    "- اعتمد حصريًا على المواد المرفقة أدناه. لا تضف أي معلومة أو رقم أو تاريخ أو دراسة أو مصدر من خارجها، ولا تخترع أي رابط أو اسم جهة.",
    "- لا تحوّل الغموض إلى يقين أبدًا: ما لم تؤكده المواد ضعه في «ما لا نعرفه» أو «ادعاءات غير مؤكدة»، لا في «ما نعرفه».",
    "- «ما نعرفه» يقتصر على وقائع واردة صراحة في المواد المرفقة. «ما لا نعرفه» يذكر الفجوات المهمة للقارئ.",
    "- الأرقام في key_numbers تُنسخ كما وردت حرفيًا في المواد مع سياقها؛ لا تحسب أو تقدّر أرقامًا جديدة.",
    "- لا تُقدّم نصائح طبية ولا تشخيصًا؛ هذا موجز تحريري داخلي.",
    "- صِغ كل الحقول بالعربية الواضحة المختصرة (قوائم قصيرة، لا حشو).",
    "- اقترح حتى ٤ زوايا تطوير واقعية من الاتجاهات المسموحة فقط، وحدد واحدة recommended=true. إن كانت المواد لا تدعم زاوية ما فلا تقترحها.",
    "- أعد الإخراج ككائن JSON واحد صالح يطابق المخطط المطلوب تمامًا، دون أي نص خارج JSON.",
  ].join("\n");

  const lines: string[] = [
    `اتجاه التطوير الذي طلبه المحرر: ${dirLabel}`,
    input.editorNote ? `ملاحظة المحرر: ${input.editorNote}` : "",
    "",
    "— المقال المنشور على سلمى (مادة موثوقة؛ سبق أن راجعه فريق التحرير) —",
    `العنوان: ${input.original.title}`,
    input.original.excerpt ? `المقتطف: ${input.original.excerpt}` : "",
    input.original.publishedAt ? `تاريخ النشر: ${input.original.publishedAt}` : "",
    input.original.sourceName ? `مصدر الخبر: ${input.original.sourceName}` : "",
    input.original.sourceUrl ? `رابط المصدر: ${input.original.sourceUrl}` : "",
    "",
    input.original.body,
  ];

  if (input.originalSourceText) {
    lines.push(
      "",
      "— نص المصدر الأصلي للخبر (مُستخرَج آليًا وتحقّقنا من جلبه) —",
      input.originalSourceText,
    );
  }
  if (input.primarySourceText) {
    lines.push(
      "",
      `— نص المصدر الأولي/الأقوى الذي حددته منظومة تصعيد المصادر${input.primarySourceUrl ? ` (${input.primarySourceUrl})` : ""} —`,
      input.primarySourceText,
    );
  }
  if (input.evidenceCardJson) {
    lines.push(
      "",
      "— بطاقة الأدلة (تحليل منهجي سابق لنفس القصة؛ استخدمها في evidence_says دون تجاوزها) —",
      input.evidenceCardJson,
    );
  }
  if (input.relatedItems.length > 0) {
    lines.push(
      "",
      "— مواد سابقة منشورة على سلمى في نفس القسم (للسياق وتحديد الجديد مقابل المعروف؛ عناوين فقط) —",
      ...input.relatedItems.map((r) => `- ${r.title}${r.publishedAt ? ` (${r.publishedAt.slice(0, 10)})` : ""}`),
    );
  }

  return [
    { role: "system", content: system },
    { role: "user", content: lines.filter((l) => l !== "").join("\n") },
  ];
}

// ---- Brief parsing (bounded, fail-closed) -----------------------------------

const cap = (s: unknown, n: number): string => String(s ?? "").trim().slice(0, n);
const capList = (v: unknown, n: number, len: number): string[] =>
  (Array.isArray(v) ? v : []).map((x) => cap(x, len)).filter(Boolean).slice(0, n);

export function parseBriefOutput(
  raw: string,
): { ok: true; brief: ResearchBrief } | { ok: false; error: string } {
  let data: unknown;
  try {
    data = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
  } catch {
    return { ok: false, error: "brief_output_invalid_json" };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, error: "brief_output_not_object" };
  }
  const o = data as Record<string, unknown>;
  const angles: BriefAngle[] = (Array.isArray(o.suggested_angles) ? o.suggested_angles : [])
    .map((a) => {
      const x = (a ?? {}) as Record<string, unknown>;
      const direction = String(x.direction ?? "");
      if (!(direction in DIRECTIONS)) return null;
      const title = cap(x.title, 160);
      if (!title) return null;
      return {
        direction: direction as BriefAngle["direction"],
        title,
        rationale: cap(x.rationale, 400),
        recommended: x.recommended === true,
      };
    })
    .filter((a): a is BriefAngle => a !== null)
    .slice(0, 4);

  const brief: ResearchBrief = {
    story_summary: cap(o.story_summary, 1200),
    new_vs_known: cap(o.new_vs_known, 1200),
    evidence_says: cap(o.evidence_says, 1600),
    key_numbers: (Array.isArray(o.key_numbers) ? o.key_numbers : [])
      .map((k) => {
        const x = (k ?? {}) as Record<string, unknown>;
        return { value: cap(x.value, 80), context: cap(x.context, 240) };
      })
      .filter((k) => k.value)
      .slice(0, 8),
    known: capList(o.known, 8, 300),
    unknown: capList(o.unknown, 8, 300),
    uncertain_claims: capList(o.uncertain_claims, 6, 300),
    suggested_angles: angles,
  };
  if (!brief.story_summary) return { ok: false, error: "brief_missing_summary" };
  return { ok: true, brief };
}

// ---- Development writing overlay ---------------------------------------------
//
// APPENDED to buildWritingInstructions(profile): the base Salma writing
// contract (banned phrases, Arabic style, grounding discipline) stays fully in
// force; this overlay only adds the development goal, structure guidance and
// honesty requirements for a deeper piece.
export function buildDevelopmentInstructions(input: {
  direction: Exclude<DevelopmentDirection, "auto">;
  editorNote: string | null;
}): string {
  const d = DIRECTIONS[input.direction];
  return [
    "— مهمة خاصة: «ما بعد الخبر» (تطوير قصة) —",
    "هذه ليست إعادة كتابة للخبر: اكتب مادة تحريرية أعمق وأكثر فائدة تجيب عمّا يعنيه الخبر ولماذا يهم وما الذي تقوله الأدلة فعلاً.",
    `الاتجاه التحريري المطلوب (${d.label}): ${d.writerGoal}`,
    input.editorNote ? `توجيه المحرر (التزم به ضمن حدود الحقائق المتحقَّق منها): ${input.editorNote}` : "",
    "",
    "البنية المقترحة (استرشادية — لا تفرضها آليًا إن كانت بنية أخرى أوضح): ماذا حدث؟ لماذا هذا مهم؟ ما الذي تقوله الأدلة؟ ما السياق؟ ماذا يعني هذا للقارئ؟ ما الذي لا نعرفه بعد؟ ماذا نراقب لاحقًا؟",
    "الطول: هذه المهمة تتجاوز صراحةً نطاق الكلمات المذكور في تعليمات النمط أعلاه — الطول المستهدف لمادة «ما بعد الخبر» هو ٤٥٠–٨٠٠ كلمة عربية. مادة بطول خبر قصير تُعد إخفاقاً في هذه المهمة؛ حقق العمق بإجابات حقيقية على الأسئلة أعلاه من المادة المتحقَّق منها، لا بالحشو أو التكرار.",
    "",
    "قواعد الأمانة في مادة معمّقة:",
    "- كل حقيقة ورقم وتاريخ واقتباس يجب أن يكون واردًا في «الحقائق المُتحقَّق منها»؛ التحليل والتفسير مسموحان فقط بوصفهما قراءة تحريرية صريحة لما ورد فيها.",
    "- ميّز بوضوح بين ما هو مؤكد وما هو غير معروف بعد؛ لا تحوّل الغموض إلى يقين، ولا تُسقط فقرة «ما لا نعرفه» إذا كانت هناك فجوات حقيقية.",
    "- لا تُحوّل الارتباط إلى سببية، ولا تضخّم قوة الدليل، ولا تقدّم نصيحة طبية تتجاوز ما قالته الجهات المذكورة في المصادر.",
    "- «التوجيه التحريري غير المُتحقَّق منه» المرفق في الرسالة (موجز البحث) يحدد الزوايا والأسئلة فقط — لا تنقل منه أي رقم أو ادعاء غير موجود في الحقائق المُتحقَّق منها.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/** Compact Arabic orientation text rendered from the brief; passed through the
 *  writer packet's UNVERIFIED-leads slot so it is explicitly fenced off from
 *  factual grounding (the same mechanism that fences discovery drafts). */
export function renderBriefOrientation(brief: ResearchBrief): string {
  const sec = (t: string, items: string[]) => (items.length ? [`${t}:`, ...items.map((i) => `- ${i}`)] : []);
  return [
    `ملخص القصة: ${brief.story_summary}`,
    brief.new_vs_known ? `الجديد مقابل المعروف: ${brief.new_vs_known}` : "",
    brief.evidence_says ? `ما تقوله الأدلة: ${brief.evidence_says}` : "",
    ...sec("ما نعرفه", brief.known),
    ...sec("ما لا نعرفه", brief.unknown),
    ...sec("ادعاءات غير مؤكدة (إن ذُكرت فبتحفظ صريح)", brief.uncertain_claims),
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/** Develop-only Editorial Director overlay: preserve the piece's DEPTH. The
 *  editor's factual re-validation and fidelity rules stay fully in force. */
export const DEVELOP_EDITOR_OVERLAY =
  "تنبيه خاص بمهمة «ما بعد الخبر»: هذه مادة تحريرية معمّقة مقصودة بطول ٤٥٠–٨٠٠ كلمة، وليست خبراً قصيراً — لا تختصرها إلى نطاق كلمات النمط الإخباري، ولا تحذف أقسام التحليل أو السياق أو «ما لا نعرفه». ركّز تحريرك على الدقة والأسلوب والأمانة فقط، واحذف الحشو والتكرار دون تقليص العمق.";
