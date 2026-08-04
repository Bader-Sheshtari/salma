// E1.4A — Salma Editorial Director (pure, no Deno/Supabase imports).
//
// This module is the automated *editorial* concern that runs AFTER the writer
// draft has passed factual validation. It reviews EVERY validated draft (never
// only drafts that tripped a style warning) and produces the best reader-facing
// version of the SAME verified story, then re-checks it:
//
//   writer draft → factual validation → [editor rewrite] → factual re-validation
//   → deterministic editorial gate → final draft (edited or original)
//
// Design mirrors salmaWriter.ts: NO Deno/Supabase imports, so the prompt, the
// strict output schema/parser, the deterministic editorial-quality gate, and the
// single-attempt orchestrator are all unit-testable in isolation (see
// salmaEditor.test.ts). The live model call and the real re-validator are
// injected by index.ts. At most TWO editor calls are ever made: the first, plus
// exactly ONE formatting-only recovery call when the first fails purely on
// output FORMATTING (invalid/truncated JSON, an invalid completion state, a
// non-string completion, or a structural schema failure). A recovery is NEVER
// made once a draft is parsed and evaluated — a factual/action/entity/risk/gate
// rejection, or a valid-but-poor edit, always retains the original. There is no
// loop and no Gemini fallback. The original writer draft always remains
// available as the safe fallback: the edited version replaces it ONLY when
// parsing succeeds, factual re-validation succeeds, required audience actions and
// protected facts are preserved, and the editorial structure is valid.

import {
  classifyEntityVisibility,
  countWords,
  extractOfficialActions,
  foldDigits,
  normalizeForCompare,
  PROFILE_WORD_BANDS,
  stripFormalSuffixes,
  type WritingProfile,
} from "./salmaWriter.ts";

export const EDITOR_PROMPT_VERSION = "e1.8-salma-editor" as const;

// Provider-level structured-output contract (OpenRouter/OpenAI `response_format`).
// The strongest structured-output mechanism the configured editor model supports:
// a strict JSON schema that constrains the completion to exactly the editor
// object — no prose, no code fence, no extra fields. This is a best-effort
// provider aid; the strict parser (parseEditorOutput) remains the sole authority
// and is NOT weakened by it. Kept to keywords honoured by strict mode (type,
// properties, required, additionalProperties, enum) so the API accepts it; the
// parser enforces non-empty fields and edit_applied === true.
export const EDITOR_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "salma_editor_output",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: [
        "title",
        "excerpt",
        "summary",
        "body",
        "edit_applied",
        "editorial_verdict",
        "issues_found",
        "changes_made",
      ],
      properties: {
        title: { type: "string" },
        excerpt: { type: "string" },
        summary: { type: "string" },
        body: { type: "string" },
        edit_applied: { type: "boolean" },
        editorial_verdict: { type: "string", enum: ["ready", "needs_human_review"] },
        issues_found: { type: "array", items: { type: "string" } },
        changes_made: { type: "array", items: { type: "string" } },
      },
    },
  },
} as const;

// The reader-facing article shape the editor produces / the writer handed in.
export type EditorArticle = {
  title: string;
  excerpt: string;
  summary: string;
  body: string;
};

// The verified fact packet the editor works from. Everything here is derived by
// index.ts from the VERIFIED source text only — never from model output.
export type EditorFactPacket = {
  profile: WritingProfile;
  // The verified source text (the sole factual grounding, same text the writer
  // validator used).
  sourceText: string;
  // Reader-essential facts the visible article MUST surface (names/identities +
  // profile-relevant numbers). Conditional facts (safety lot/strength) surface
  // only when needed to identify the affected product. Verification-only facts
  // (NDC/registration/expiry/DOI codes) may be dropped from the visible story.
  readerEssential: string[];
  conditional: string[];
  verificationOnly: string[];
  // Official reader/facility actions the source explicitly requested (safety
  // alerts). These must survive the edit.
  requiredActions: string[];
};

// -------------------------------------------------------------------------
// Fact-packet construction (pure): classify the writer's mustPreserve entities
// into reader-essential / conditional / verification-only for this profile, and
// derive the required official actions from the verified source text. index.ts
// calls this so the editor and the writer share ONE deterministic notion of
// which facts are reader-facing vs verification-only.
// -------------------------------------------------------------------------
export function buildFactPacket(input: {
  profile: WritingProfile;
  sourceText: string;
  mustPreserve?: string[];
}): EditorFactPacket {
  const readerEssential: string[] = [];
  const conditional: string[] = [];
  const verificationOnly: string[] = [];
  for (const ent of input.mustPreserve ?? []) {
    const vis = classifyEntityVisibility(ent, input.profile, input.sourceText);
    if (vis === "essential") readerEssential.push(ent);
    else if (vis === "conditional") conditional.push(ent);
    else verificationOnly.push(ent);
  }
  return {
    profile: input.profile,
    sourceText: input.sourceText,
    readerEssential,
    conditional,
    verificationOnly,
    requiredActions: extractOfficialActions(input.sourceText),
  };
}

// -------------------------------------------------------------------------
// Editor prompt (Arabic). Encodes the editorial role and the Salma rules:
// Arabic-first naming, strong first impression, per-profile compression,
// attractive-not-sensational tone, distinct excerpt/summary, and the strict
// JSON output contract. It is NOT wired to a live model in this module; index.ts
// supplies the transport.
// -------------------------------------------------------------------------
const PROFILE_EDIT_GUIDANCE: Record<WritingProfile, string> = {
  quick_news:
    "خبر سريع: عنوان 7–12 كلمة، مقتطف جملة واحدة (20–30 كلمة)، نصّ قصير في 2–4 فقرات. يجب أن تخدم كل جملة ظاهرة واحدة على الأقل من: ما الذي حدث؟ لماذا يهمّ؟ من المتأثّر؟ ما الإجراء المطلوب؟ ما أهمّ نتيجة مؤكّدة؟ احذف أي جملة أو خلفية لا تحسّن فعلياً واحدة من هذه الوظائف الخمس.",
  standard_news:
    "خبر معياري: وضّح ما تغيّر ومن المتأثّر، وأضف أهمّ سياق مفيد فقط، دون حشو أو تكرار.",
  regulation_or_service:
    "قرار/لائحة/خدمة: اذكر ما تغيّر ومن المتأثّر وتاريخ السريان والإجراء المطلوب والمهلة/الرسوم/الأهلية عند الحاجة، بشرح عربي واضح بدل النصّ القانوني.",
  safety_alert:
    "تحذير سلامة قصير موجّه للقارئ العام: يجب أن تخدم كل جملة ظاهرة واحدة على الأقل من الوظائف الخمس (ما الذي حدث؟ لماذا يهمّ؟ من المتأثّر؟ ما الإجراء المطلوب؟ ما أهمّ نتيجة مؤكّدة؟). أبقِ هوية المنتج المفهومة وسبب التحذير وأهمّ خطر مؤكّد بلغة بسيطة والإجراء الصحيح للمريض والمنشأة وهل سُجّلت إصابات. احذف عادةً: قوائم الاستخدامات العلاجية، وقيم الجرعة/التركيز، ووصف العبوة أو القارورة أحادية الجرعة، وأرقام الدفعات، وأكواد NDC/التسجيل، وتواريخ التوزيع/الصلاحية، والاسم الإنجليزي الرسمي الطويل، وقوائم المضاعفات المطوّلة، ولغة إجراءات السحب الرسمية، وكلمة «طوعاً» حين لا تضيف قيمة. لا تُبقِ الدفعة/التركيز إلا إذا احتاجها القارئ للتعرّف على المنتج المتأثّر.",
  research_study:
    "دراسة: اذكر ما دُرِس ونوع الدراسة وحجم العيّنة عند أهمّيته والنتيجة الأساسية ومعناها العملي وحدّاً مهمّاً، وميّز بين الارتباط والسببية. احذف DOI والمعرّفات الداخلية وقوائم المؤلّفين الطويلة.",
};

/** Build the Arabic editorial-director system prompt for a profile. When
 *  `opts.strictJsonRecovery` is set (the single formatting-only recovery call),
 *  a strict reminder to return ONLY the valid JSON object is appended. */
// E1.8 — Arabic, reader-facing descriptions of each deterministic repairable
// editorial issue, injected into the ONE targeted editorial-repair instruction
// so the model is told exactly what surface problem to correct (and nothing else).
const REPAIR_ISSUE_TEXT: Record<string, string> = {
  editorial_title_has_english: "العنوان يحتوي حروفاً إنجليزية: اجعله عربياً بالكامل.",
  editorial_excerpt_has_english: "المقتطف يحتوي حروفاً إنجليزية: اجعله عربياً بالكامل دون أي اسم إنجليزي.",
  editorial_summary_has_english: "الملخّص يحتوي حروفاً إنجليزية: اجعله عربياً بالكامل دون أي اسم إنجليزي.",
  editorial_foreign_name_english_only:
    "اسم أجنبي ورد بالإنجليزية فقط في أول فقرة: اكتبه بالعربية أولاً ثم ضع الأصل الإنجليزي بين قوسين مرّة واحدة.",
  editorial_english_name_repeated_after_first:
    "الاسم الإنجليزي مكرّر بعد أوّل ذكر (أو بين المقتطف والنص): أبقِه مرّة واحدة فقط بين قوسين عند أوّل ذكر في الفقرة الأولى، وبعدها العربية وحدها.",
  editorial_promo_or_literal_phrase:
    "صياغة حرفية أو تنظيمية غير ضرورية (مثل «على مستوى المستخدم» أو «وفقاً للإشعار الرسمي» أو «سحب طوعي شامل»): استبدلها بجملة خبرية مباشرة.",
  editorial_unnecessary_voluntary:
    "كلمة «طوعاً/طوعي» غير ضرورية للقارئ: احذفها واكتب الفعل الحدثي المباشر.",
  editorial_unnecessary_label:
    "اختصار تنظيمي غير ضروري (USP/NDC/Lot/Inc/LLC): احذفه ما لم يكن حذفه يسبّب لبساً حقيقياً في الهوية.",
  editorial_arabic_agreement_error:
    "خطأ في مطابقة العدد للمعدود: «ثلاث دفعات» لا «ثلاثة دفعات»، و«ثلاثة أدوية» لا «ثلاث أدوية».",
  editorial_press_release_opening:
    "المقدّمة تبدأ بصيغة إعلان (أعلنت/كشفت/وفقاً للإشعار): ابدأ بالفعل الحدثي المباشر.",
};

export function buildEditorInstructions(
  profile: WritingProfile,
  opts: { strictJsonRecovery?: boolean; repairIssues?: string[] } = {},
): string {
  const base = `أنت رئيس تحرير محترف للأخبار الصحية في منصة "سلمى". تتسلّم مسوّدة كتبها المحرّر الآلي عن قصّة مُتحقَّق منها، ومهمّتك إنتاج أفضل نسخة موجّهة للقارئ من القصّة نفسها دون تغيير أي حقيقة. (إصدار التعليمات: ${EDITOR_PROMPT_VERSION})

نوع المادة:
${PROFILE_EDIT_GUIDANCE[profile]}

مبدأ سلمى التحريري:
- الحقيقة اللازمة للتحقّق ليست بالضرورة حقيقة يجب أن تظهر في المقال. اجعل النصّ المرئي يجيب بسرعة: ماذا حدث؟ لماذا يهمّ؟ من المتأثّر؟ ما الذي يجب على القارئ أو الجهة فعله؟ وما أهمّ نتيجة أو حدّ مؤكّد؟ واترك التفاصيل التقنية للتحقّق فقط.

يمكنك: إعادة صياغة العنوان، وإعادة بناء المقدّمة، والاختصار، وحذف التكرار، وحذف التفاصيل التنظيمية أو التقنية غير الضرورية، وتبسيط المصطلحات الطبية دون تغيير معناها، وتحسين الإيقاع والقواعد، وترتيب الحقائق حسب أهمّيتها للقارئ، ونقل الأسماء الأجنبية إلى العربية.

يُمنع منعاً باتاً: إضافة أي حقيقة أو خلفية غير موجودة في المصدر، أو تغيير رقم أو تاريخ أو نتيجة أو خطر أو منتج أو جمهور أو إجراء أو قرار رسمي، أو المبالغة في الخطر أو التقليل منه، أو تحويل الارتباط إلى سببية، أو حذف تحذير أساسي أو إجراء مطلوب، أو استخدام لغة مثيرة أو دعائية، أو اختلاق ترجمة عربية تُخطئ في تعريف الاسم.

سياسة التعريب أولاً (إلزامية لكل اسم أجنبي أساسي: الأدوية والشركات والمنتجات والجهات):
- اكتب الاسم بالعربية أولاً (تعريباً أو نقحرةً)، ثم ضَع الاسم الأجنبي الأصلي الدقيق بين قوسين عند أوّل ذكر فقط، هكذا: «سيكلوفوسفاميد (Cyclophosphamide)»، «سني فارماتيك (Sunny Pharmtech)»، «بابافيرين (Papaverine)»، «أمريكان ريجنت (American Regent)».
- لا تحذف الاسم الأجنبي الأصلي بالكامل مطلقاً: يجب أن يظهر الاسم الأصلي الدقيق مرّة واحدة بالضبط بين قوسين عند أوّل ذكر، حتى لا تضيع الهوية الدقيقة للمنتج أو الجهة، ولا تختصره أو تبدّله بصيغة قد تغيّر الهوية.
- بعد أوّل ذكر، استخدم العربية وحدها، ولا تكرّر الاسم الإنجليزي ولا القوس التوضيحي في المقتطف أو بقية النص.
- العنوان عربي بالكامل: لا تضع أي حروف إنجليزية في العنوان إطلاقاً.
- ضع الهوية الأساسية القصيرة فقط داخل القوس (مثل Cyclophosphamide أو Papaverine أو American Regent)، واحذف اللواحق التنظيمية أو الشكلية غير الضرورية مثل Hydrochloride وfor Injection وInjection, USP وUSP وNDC وLot وInc وLLC وصيغ الجرعة، ما لم يكن حذفها يسبّب لبساً حقيقياً في الهوية. لا تُبقِ الاسم الإنجليزي الأطول إلا حين يكون اختصاره قد يسبّب خلطاً فعلياً. أبقِ الإنجليزية عند أضيق حدّ ممكن.

قيمة القارئ أولاً (للأخبار السريعة وتحذيرات السلامة): يجب أن تخدم كل جملة ظاهرة واحدة على الأقل من الوظائف الخمس. احذف الجمل والتفاصيل التي لا تحسّن فعلياً أياً منها. الحقيقة المتحقَّقة قد تبقى في حزمة الحقائق دون أن تظهر في المقال المرئي، فليس كل ما تحقّقنا منه يلزم عرضه.

قلّل التفاصيل الطبية والتنظيمية غير الضرورية: اختر أهمّ خطر مؤكّد بلغة مفهومة للقارئ. فضّل «قد تسبب الجسيمات مضاعفات خطرة، من بينها انسداد الأوعية الدموية»، وتجنّب السلاسل المفصّلة غير الضرورية مثل «التهاب الوريد أو ورم حبيبي أو انسداد قد يصل إلى أحداث خثرية مهددة للحياة». أبقِ تفصيلاً أكبر فقط إذا كان حذفه يجعل التحذير مضلّلاً أو يمنع القارئ من التعرّف على المنتج المتأثّر.

الإبقاء الإلزامي على الخطر في تحذيرات السلامة: حين يذكر المصدر المُتحقَّق منه أو حزمة الحقائق خطراً طبياً مؤكّداً، يجب أن يُبقي المقال النهائي المرئي جملة واحدة موجزة على الأقل تشرح أهمّ خطر بلغة مفهومة للقارئ. التلخيص لتحذير السلامة قد يحذف التفاصيل التقنية الثانوية، لكنه يجب أن يُبقي دائماً على العناصر الخمسة: (1) ما الذي حدث، (2) المنتج أو الجمهور المتأثّر، (3) أهمّ خطر مؤكّد، (4) الإجراء المطلوب من المريض أو المنشأة، (5) هل سُجّلت إصابات أو آثار جانبية حين يذكر المصدر ذلك. يجوز تبسيط قائمة مضاعفات طويلة إلى الخطر الأهمّ والأكثر دلالة وحده، لكن يُمنع حذف كل معلومات الخطر لمجرّد تقصير المقال. لا تختلق خطراً ولا تقوّيه ولا تعمّمه ولا تبالغ فيه، وأبقِ أي مؤهِّل شدّة ورد في المصدر (مثل «في حالات خطرة» أو «قد يؤدي»). لا تستبدل الخطر بجملة فارغة مثل «قد يكون خطيراً» وحدها. النمط المفضّل: «وحذّرت من أن استخدام المنتج المتأثر قد يسبب تهيجاً أو تورماً موضعياً، وقد يؤدي في حالات خطرة إلى انسداد الأوعية الدموية».

أمانة نسبة الفعل: لا تنسب السحب إلى الجهة التنظيمية (مثل إدارة الغذاء والدواء) لمجرّد أنّ الخبر منشور على موقعها. ميّز بين الشركة التي بدأت السحب والجهة التي نشرته أو أعلنته أو نسّقته أو أشرفت عليه. لسحبٍ بدأته شركة ونشرته الجهة، اكتب «سحبت شركة أمريكان ريجنت…»، ولا تكتب «سحبت إدارة الغذاء والدواء…» إلا إذا نصّ المصدر صراحةً على أنّ الجهة نفسها هي من نفّذ السحب.

لا طمأنة مطلقة غير مدعومة: لا تحوّل «غير مشمولة بالسحب» أو «لم تتأثّر» أو «لم ترد بشأنها مشكلة» إلى «آمنة» أو «تظل آمنة» أو «خالية من المخاطر» ما لم يدعم المصدر صراحةً هذه الصيغة المطلقة.

الانطباع الأول:
- يجب أن ينقل العنوان والمقدّمة الخبر الحقيقي فوراً: الحدث أو التغيير أو المنفعة أو الخطر المهمّ أو الأثر العملي. لا تبدأ عادةً بـ«أعلنت الشركة» أو «كشفت الجهة» أو «أفاد بيان» أو «وفقاً للإشعار الرسمي» إلا إذا كانت هوية الجهة المعلِنة هي الخبر نفسه. ويجب ألا تكرّر المقدّمة العنوان بل تضيف أهمّ سياق.
- في الأخبار السريعة وتحذيرات السلامة تحديداً، ابدأ بالفعل الحدثي المباشر لا بصيغة الإعلان: «سحبت شركة سني فارماتيك ثلاث دفعات...» أوضح وأقوى من «أعلنت شركة سني فارماتيك سحباً طوعياً...».

مطابقة العدد للمعدود:
- مع جمع المؤنّث استخدم الصيغة المجرّدة: «ثلاث دفعات»، «ثلاث حالات»، «ثلاث شركات» — لا «ثلاثة دفعات».
- مع جمع المذكّر استخدم صيغة التاء المربوطة: «ثلاثة أدوية»، «ثلاثة مرضى»، «ثلاثة مستشفيات» — لا «ثلاث أدوية». صحّح أي خطأ في المطابقة وردَ في المسوّدة.

الجاذبية بلا إثارة: وضوح وقيمة وسرعة فهم وإيقاع طبيعي وترتيب مفيد — لا مبالغة ولا تخويف ولا يقين غير مدعوم ولا عناوين طُعم.

المقتطف والملخّص لهما وظيفتان مختلفتان: المقتطف يشرح الحدث المركزي ويدعم العنوان دون تكراره حرفياً؛ والملخّص «باختصار» يعطي الخلاصة العملية للقارئ في جملة واحدة مختلفة عن العنوان والمقتطف والمقدّمة. لا تُكرّر الجملة نفسها في أكثر من حقل.

عقد المخرجات: أعد كائن JSON واحداً فقط، دون أي نصّ قبله أو بعده ودون أسيجة برمجية، بالحقول التالية حصراً ولا غير:
{"title":"…","excerpt":"…","summary":"…","body":"فقرات مفصولة بسطر فارغ","edit_applied":true,"editorial_verdict":"ready" أو "needs_human_review","issues_found":["…"],"changes_made":["…"]}
- لا حقول إضافية. جميع حقول المقال نصوص غير فارغة. issues_found وchanges_made مصفوفتا قيم قصيرة.`;
  if (opts.repairIssues && opts.repairIssues.length) {
    const list = opts.repairIssues
      .map((code) => `- ${REPAIR_ISSUE_TEXT[code] ?? code}`)
      .join("\n");
    return (
      base +
      `\n\nتصحيح تحريري موجّه (المسوّدة أدناه صحيحة من حيث الحقائق لكنها تحمل مشكلات صياغة سطحية فقط): أعد كتابة المسوّدة نفسها مع تصحيح هذه المشكلات المحدّدة حصراً:\n${list}\n\nلا تُغيّر أي حقيقة أو خطر أو رقم أو تاريخ أو إجراء مطلوب أو جمهور أو نسبة فعل أو هوية منتج. لا تحذف أي معلومة أساسية ولا تضِف أي جديد. صحّح فقط مشكلات الصياغة المذكورة أعلاه، وأعد الكائن نفسه بعقد JSON نفسه تماماً.`
    );
  }
  if (!opts.strictJsonRecovery) return base;
  return (
    base +
    `\n\nتنبيه صارم (محاولة تصحيح التنسيق فقط): تعذّرت قراءة المخرجات السابقة بسبب خطأ في التنسيق. أعد الآن كائن JSON واحداً صالحاً ومكتملاً يطابق العقد أعلاه تماماً: بلا أي نصّ أو شرح قبله أو بعده، وبلا أسيجة برمجية (\`\`\`)، وبلا أي حقول إضافية، مع التأكّد أن كل حقول المقال نصوص غير فارغة وأن المخرجات غير مبتورة. لا تُغيّر أي حقيقة ولا تحذف أي إجراء مطلوب — صحّح التنسيق فقط.`
  );
}

/** Render the user message the editor works from: the fact packet and the draft. */
export function renderEditorPacket(input: {
  packet: EditorFactPacket;
  draft: EditorArticle;
}): string {
  const p = input.packet;
  const listOr = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "—");
  return [
    `النوع التحريري: ${p.profile}`,
    ``,
    `النصّ المصدري المُتحقَّق منه (المرجع الوحيد للحقائق — لا تُضِف شيئاً خارجه):`,
    p.sourceText || "—",
    ``,
    `حقائق أساسية للقارئ (يجب أن تظهر):`,
    listOr(p.readerEssential),
    ``,
    `حقائق مشروطة (أظهرها فقط عند الحاجة لتحديد المنتج المتأثّر):`,
    listOr(p.conditional),
    ``,
    `حقائق للتحقّق فقط (احذفها من النصّ المرئي إلا إذا كانت ضرورية حقاً):`,
    listOr(p.verificationOnly),
    ``,
    `إجراءات مطلوبة يجب الحفاظ عليها:`,
    listOr(p.requiredActions),
    ``,
    `المسوّدة الأصلية:`,
    `العنوان: ${input.draft.title}`,
    `المقتطف: ${input.draft.excerpt}`,
    `الملخّص: ${input.draft.summary}`,
    `النص:`,
    input.draft.body,
  ].join("\n");
}

// -------------------------------------------------------------------------
// Strict editor output schema + parser. Non-repairing: any deviation is a
// specific rejection reason (never a throw, never a silent repair), so a
// malformed edit can never silently replace the writer draft.
// -------------------------------------------------------------------------
export type EditorVerdict = "ready" | "needs_human_review";

export type EditorOutput = {
  title: string;
  excerpt: string;
  summary: string;
  body: string;
  edit_applied: true;
  editorial_verdict: EditorVerdict;
  issues_found: string[];
  changes_made: string[];
};

export type EditorParseError =
  | "editor_output_truncated"
  | "editor_output_code_fence_invalid"
  | "editor_output_extra_text"
  | "editor_output_multiple_objects"
  | "editor_output_invalid_json"
  | "editor_output_schema_invalid";

const EDITOR_ALLOWED_FIELDS = [
  "title",
  "excerpt",
  "summary",
  "body",
  "edit_applied",
  "editorial_verdict",
  "issues_found",
  "changes_made",
] as const;

// Conservative caps (a real Arabic article + short control lists sit well under).
const ED_MAX_TITLE_CHARS = 300;
const ED_MAX_EXCERPT_CHARS = 1000;
const ED_MAX_SUMMARY_CHARS = 400;
const ED_MAX_BODY_CHARS = 20000;
const ED_MAX_LIST_ITEMS = 24;
const ED_MAX_LIST_ITEM_CHARS = 160;

/** Scan from `{` at `start` to its matching top-level `}`, honoring JSON string
 *  quoting/escapes. closed=false ⇒ unterminated/truncated object. */
function scanJsonObject(s: string, start: number): { end: number; closed: boolean } {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return { end: i, closed: true };
    }
  }
  return { end: s.length - 1, closed: false };
}

/** Unwrap a single whole-payload ```json fence, or leave a bare object untouched. */
function unwrapCodeFence(
  text: string,
): { ok: true; text: string } | { ok: false; error: EditorParseError } {
  if (!text.startsWith("```")) return { ok: true, text };
  const m = text.match(/^```([^\n`]*)\n([\s\S]*?)\n?```$/);
  if (!m) return { ok: false, error: "editor_output_code_fence_invalid" };
  const lang = m[1].trim().toLowerCase();
  if (lang && lang !== "json") return { ok: false, error: "editor_output_code_fence_invalid" };
  if (m[2].includes("```")) return { ok: false, error: "editor_output_code_fence_invalid" };
  return { ok: true, text: m[2].trim() };
}

function isControlList(v: unknown): v is string[] {
  return (
    Array.isArray(v) &&
    v.length <= ED_MAX_LIST_ITEMS &&
    v.every((x) => typeof x === "string" && x.trim().length > 0 && x.length <= ED_MAX_LIST_ITEM_CHARS)
  );
}

/**
 * Strictly parse the raw editor response into an EditorOutput. Accepts EXACTLY
 * one bare JSON object (optionally wrapped in one ```json fence). Rejects — with
 * a specific reason — surrounding prose, multiple objects, truncated/malformed
 * JSON, and any schema violation (missing/extra/empty/wrong-typed field,
 * edit_applied !== true, an invalid verdict, or a non-control-list array).
 */
export function parseEditorOutput(
  raw: string,
): { ok: true; output: EditorOutput } | { ok: false; error: EditorParseError } {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return { ok: false, error: "editor_output_invalid_json" };

  const unfenced = unwrapCodeFence(trimmed);
  if (!unfenced.ok) return unfenced;
  const text = unfenced.text.trim();

  const open = text.indexOf("{");
  if (open === -1) return { ok: false, error: "editor_output_invalid_json" };
  if (text.slice(0, open).trim() !== "") return { ok: false, error: "editor_output_extra_text" };

  const { end, closed } = scanJsonObject(text, open);
  if (!closed) return { ok: false, error: "editor_output_truncated" };

  const after = text.slice(end + 1).trim();
  if (after !== "") {
    return {
      ok: false,
      error: after.startsWith("{") ? "editor_output_multiple_objects" : "editor_output_extra_text",
    };
  }

  let obj: unknown;
  try {
    obj = JSON.parse(text.slice(open, end + 1));
  } catch {
    return { ok: false, error: "editor_output_invalid_json" };
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, error: "editor_output_schema_invalid" };
  }

  const o = obj as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (!(EDITOR_ALLOWED_FIELDS as readonly string[]).includes(key)) {
      return { ok: false, error: "editor_output_schema_invalid" };
    }
  }
  for (const key of ["title", "excerpt", "summary", "body"] as const) {
    if (typeof o[key] !== "string") return { ok: false, error: "editor_output_schema_invalid" };
  }
  if (o.edit_applied !== true) return { ok: false, error: "editor_output_schema_invalid" };
  if (o.editorial_verdict !== "ready" && o.editorial_verdict !== "needs_human_review") {
    return { ok: false, error: "editor_output_schema_invalid" };
  }
  if (!isControlList(o.issues_found) || !isControlList(o.changes_made)) {
    return { ok: false, error: "editor_output_schema_invalid" };
  }

  const title = (o.title as string).trim();
  const excerpt = (o.excerpt as string).trim();
  const summary = (o.summary as string).trim();
  const body = (o.body as string).trim();
  // Every article field must be a non-empty string.
  if (!title || !excerpt || !summary || !body) {
    return { ok: false, error: "editor_output_schema_invalid" };
  }
  if (
    title.length > ED_MAX_TITLE_CHARS ||
    excerpt.length > ED_MAX_EXCERPT_CHARS ||
    summary.length > ED_MAX_SUMMARY_CHARS ||
    body.length > ED_MAX_BODY_CHARS
  ) {
    return { ok: false, error: "editor_output_schema_invalid" };
  }
  return {
    ok: true,
    output: {
      title,
      excerpt,
      summary,
      body,
      edit_applied: true,
      editorial_verdict: o.editorial_verdict,
      issues_found: o.issues_found as string[],
      changes_made: o.changes_made as string[],
    },
  };
}

// -------------------------------------------------------------------------
// Deterministic editorial-quality gate. Purely structural/stylistic checks over
// the FINAL reader-facing article. Each check is classified by severity:
//   - "blocking"     → the edited draft is NOT publishable as-is; the editor
//                      pass keeps the original writer draft and marks the run
//                      needs_human_review. (Reserved for the strongest
//                      Arabic-first / first-impression violations.)
//   - "needs_review" → publishable, but the run verdict becomes
//                      needs_human_review so an editor eyeballs it.
//   - "advisory"     → informational only; never changes the verdict.
// These checks NEVER weaken factual validation (that runs separately, first).
// -------------------------------------------------------------------------
export type EditorialSeverity = "blocking" | "needs_review" | "advisory";
export type EditorialGateResult = {
  blocking: string[];
  needs_review: string[];
  advisory: string[];
};

// E1.8 — Deterministic editorial failures that a single targeted repair call can
// fix WITHOUT touching any fact, risk, number, action, audience, attribution, or
// product identity. These are surface/wording issues (English placement, literal
// regulatory phrasing, unnecessary labels, number agreement, press-release
// openings), NOT factual failures. When a factually-valid first edit carries any
// of these, the orchestrator spends its second call on an editorial repair.
const REPAIRABLE_EDITORIAL_CODES: ReadonlySet<string> = new Set([
  "editorial_title_has_english",
  "editorial_excerpt_has_english",
  "editorial_summary_has_english",
  "editorial_foreign_name_english_only",
  "editorial_english_name_repeated_after_first",
  "editorial_promo_or_literal_phrase",
  "editorial_unnecessary_voluntary",
  "editorial_unnecessary_label",
  "editorial_arabic_agreement_error",
  "editorial_press_release_opening",
]);

/** The deterministic, repairable editorial issues raised by the gate (blocking +
 *  needs_review), in a stable order. Advisory warnings are never repair-worthy. */
export function repairableEditorialIssues(gate: EditorialGateResult): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const code of [...gate.blocking, ...gate.needs_review]) {
    if (REPAIRABLE_EDITORIAL_CODES.has(code) && !seen.has(code)) {
      seen.add(code);
      out.push(code);
    }
  }
  return out;
}

// Distinct Latin technical tokens (OUTSIDE approved first-mention glosses)
// beyond this read as too much English.
const EDITORIAL_MAX_ENGLISH_TOKENS = 3;
// A single first-mention parenthetical carrying more Latin words than this is a
// phrase, not an identity — flagged as excessive foreign text inside the gloss.
const EDITORIAL_MAX_PAREN_LATIN_WORDS = 4;
const EDITORIAL_MAX_IDENTIFIERS = 2;
const EDITORIAL_DUP_JACCARD = 0.7;
// A single paragraph longer than this (words) reads as a wall of text.
const EDITORIAL_MAX_PARAGRAPH_WORDS = 90;

// Press-release / bureaucratic openers a reader-first lead should avoid.
const PRESS_RELEASE_OPENERS = [
  "اعلنت", "اعلن", "كشفت", "كشف", "افادت", "افاد", "ذكر بيان", "قال بيان",
  "وفقا للاشعار", "وفق الاشعار", "بموجب الاشعار", "اصدرت بيان",
];
// Literal-translation / press-release phrases flagged in the body (§10).
const FLAGGED_PHRASES = [
  "على مستوى المستخدم",
  "الاشعار الرسمي",
  "جرى تحديدها على انها",
  "على انها",
  "المنتج ذي القارورة",
  "الدفعة التوزيع",
];
// Unnecessary regulatory labels/abbreviations.
const UNNECESSARY_LABELS = ["USP", "NDC", "LOT", "INC", "LLC", "LTD"];
// Risk vocabulary a safety alert must not silently drop.
const RISK_TERMS = [
  "خطر", "خطير", "خطيرة", "مضاعفات", "وفاة", "الوفاة", "تجلط", "تخثر", "انسداد",
  "التهاب", "تسمم", "نزيف", "عدوى", "ضرر", "تهيج", "تورم",
];
// Feminine plural nouns used to catch a number/noun gender-agreement slip.
const FEM_PLURALS = ["دفعات", "حالات", "سنوات", "عبوات", "شركات", "دول", "نساء", "جرعات"];
// Masculine-form counting words (with taa marbuta) that are WRONG before a
// feminine plural (correct Arabic polarity uses the bare form: "ثلاث دفعات").
const MASC_NUMBER_WORDS = ["ثلاثة", "اربعة", "خمسة", "ستة", "سبعة", "ثمانية", "تسعة"];
// Bare (feminine-form) counting words that are WRONG before a MASCULINE plural
// (correct polarity uses the taa-marbuta form: "ثلاثة أدوية"). Kept as a short
// curated list — this is a targeted agreement check, NOT a grammar engine.
const FEM_NUMBER_WORDS = ["ثلاث", "اربع", "خمس", "ست", "سبع", "ثمان", "تسع"];
// Plurals whose singular is masculine, so they must take the taa-marbuta number
// form ("ثلاثة أدوية"/"ثلاثة مرضى"/"ثلاثة مستشفيات"), never the bare form.
const MASC_PLURALS = ["ادوية", "مرضى", "مستشفيات"];

// --- Reader-value / regulatory-detail discipline (quick_news + safety_alert) --
// These lists power the E1.7 editorial-judgment warnings: for fast, action-
// oriented profiles a verified-but-unnecessary clinical/regulatory detail, a
// mis-attributed recall, or an unsupported absolute reassurance is flagged so
// the article is not marked editorially ready as a regulatory-notice-in-disguise.

// A safety alert usually does NOT need to explain the medicine's clinical uses.
const CLINICAL_USE_PATTERNS = [
  "يستخدم لعلاج", "يستعمل لعلاج", "يستخدم في علاج", "يستخدم في حالات",
  "لعلاج انواع", "لعلاج السرطان", "المتلازمة الكلوية",
];
// Dosage strength / packaging detail rarely needed to identify or act.
const STRENGTH_PACKAGING_PATTERNS = [
  "غرام", "مليغرام", "ملغم", "ملغ", "تركيز", "بتركيز", "بتركيزين",
  "احادية الجرعة", "وحيدة الجرعة", "قارورة احادية", "قوارير احادية", "جرعة واحدة",
];
// Specific, mostly mutually-exclusive complication phrases. More than
// EDITORIAL_MAX_COMPLICATIONS distinct ones read as an unnecessary risk chain.
const COMPLICATION_TERMS = [
  "التهاب الوريد", "ورم حبيبي", "انسداد", "خثرية", "تجلط", "تخثر",
  "نزيف", "تسمم", "عدوى", "صمة", "انصمام",
];
const EDITORIAL_MAX_COMPLICATIONS = 2;
// Batch / lot references (Arabic phrases + Latin lot/batch words).
const BATCH_PHRASES = ["رقم الدفعة", "الدفعة رقم", "دفعة رقم", "رقم التشغيلة", "ارقام الدفعات"];
const BATCH_LATIN_RE = /\b(lot|batch)\b/;
// Formal English identity wording to drop (the regulatory-label abbreviations
// USP/NDC/Inc/LLC stay under UNNECESSARY_LABELS; these are the long product-form
// words that a short Arabic-first identity does not need).
const FORMAL_ENGLISH_PATTERNS = ["hydrochloride", "for injection", "injection"];
// The recall verb credited to a REGULATOR subject (wrong when a company
// initiated the recall). Matched as normalized substrings.
const REGULATOR_RECALL_PATTERNS = [
  "سحبت ادارة", "سحب ادارة", "تسحب ادارة", "سحبت هيئة", "سحبت الهيئة", "سحبت هيئه",
  "سحبت السلطات", "سحب السلطات", "سحبت وزارة", "سحبت الجهات الصحية",
];
// "Voluntary" wording (طوعاً / طوعي …) is regulatory framing a reader-first
// story does not need; flagged as a repairable editorial detail.
const VOLUNTARY_TOKENS = ["طوعا", "طوعي", "طوعية", "طوعيا", "الطوعي", "طوعياً"];
// Absolute-reassurance wording that must be explicitly supported by the source.
const ABSOLUTE_SAFE_TOKENS = ["امنة", "امن", "امنه", "امنون", "امنا", "امنين"];
const ABSOLUTE_SAFE_PHRASES = [
  "خالية من المخاطر", "خاليه من المخاطر", "خالية من الخطر",
  "لا خطر منها", "لا مخاطر", "بلا مخاطر", "تظل امنة", "تبقى امنة",
];
// Soft reader-value length cap (words) beyond which the body carries more than a
// fast reader needs. Below the writer's band.max; advisory only.
const EDITORIAL_READER_VALUE_MAX: Partial<Record<WritingProfile, number>> = {
  quick_news: 140,
  safety_alert: 140,
};

const LATIN_ALPHA_RE = /[A-Za-z]{2,}/g;
const LATIN_WORD_RE = /[A-Za-z][A-Za-z]{3,}/g; // ≥4-letter English word
const CODE_TOKEN_RE = /\b\d[\d\-/]{3,}\d\b/g;

/** Light normalize for phrase matching: fold digits, strip Arabic diacritics/
 *  tatweel, unify alef/hamza forms, collapse whitespace, lowercase. Keeps
 *  sentence structure so opener/phrase checks stay meaningful. */
function normalizePhrase(s: string): string {
  return foldDigits(s ?? "")
    .replace(/[\u064B-\u065F\u0610-\u061A\u0670\u0640]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function jaccard(a: string, b: string): number {
  const sa = new Set(a.split(" ").filter(Boolean));
  const sb = new Set(b.split(" ").filter(Boolean));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/** Character index spans of every `(...)` group, so a Latin token inside a
 *  parenthetical gloss ("سيكلوفوسفاميد (Cyclophosphamide)") is recognised as an
 *  allowed first-mention gloss rather than inline English. */
function parenSpans(text: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  const re = /\([^)]*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    spans.push({ start: m.index, end: m.index + m[0].length });
  }
  return spans;
}

function insideAnySpan(idx: number, spans: { start: number; end: number }[]): boolean {
  return spans.some((s) => idx >= s.start && idx < s.end);
}

/**
 * Deterministic editorial gate over the final article. `opts.verificationOnly`
 * is the subset of preserved entities classified verification-only for this
 * profile (so leaked codes can be counted). `opts.sourceText` is the VERIFIED
 * source; when present it enables the recall-attribution and unsupported-
 * absolute-reassurance checks (both need to know what the source actually says).
 */
export function editorialGate(
  article: EditorArticle,
  profile: WritingProfile,
  opts: { verificationOnly?: string[]; sourceText?: string } = {},
): EditorialGateResult {
  const blocking = new Set<string>();
  const review = new Set<string>();
  const advisory = new Set<string>();

  const title = (article.title ?? "").trim();
  const excerpt = (article.excerpt ?? "").trim();
  const summary = (article.summary ?? "").trim();
  const body = (article.body ?? "").trim();

  // --- English placement policy (E1.8) --------------------------------------
  // Field discipline: title / excerpt / summary are Arabic-only; the body is
  // Arabic-first and may carry a foreign identity EXACTLY ONCE, in the first
  // body paragraph, as a parenthetical gloss «العربية (English)». After that
  // single first mention the body stays Arabic — the name is never repeated and
  // the gloss is never restated. `visible` is retained for downstream checks.
  const visible = `${excerpt}\n${body}`;
  const bodyParas = body.split(/\n\s*\n/);
  const firstPara = bodyParas[0] ?? "";
  const restBody = bodyParas.slice(1).join("\n\n");

  const hasLatin = (s: string): boolean => {
    LATIN_ALPHA_RE.lastIndex = 0;
    const r = LATIN_ALPHA_RE.test(foldDigits(s));
    LATIN_ALPHA_RE.lastIndex = 0;
    return r;
  };

  // English in the Arabic-only fields.
  if (hasLatin(title)) blocking.add("editorial_title_has_english"); // title — BLOCKING
  if (hasLatin(excerpt)) review.add("editorial_excerpt_has_english"); // excerpt — needs_review
  if (hasLatin(summary)) review.add("editorial_summary_has_english"); // summary — needs_review

  // First body paragraph: a ≥4-letter Latin word OUTSIDE a parenthetical gloss
  // is a foreign name used bare (English-first naming). BLOCKING.
  {
    const spans = parenSpans(firstPara);
    const folded = foldDigits(firstPara);
    let m: RegExpExecArray | null;
    LATIN_WORD_RE.lastIndex = 0;
    while ((m = LATIN_WORD_RE.exec(folded)) !== null) {
      if (!insideAnySpan(m.index, spans)) {
        blocking.add("editorial_foreign_name_english_only");
        break;
      }
    }
    LATIN_WORD_RE.lastIndex = 0;
  }

  // Any ≥4-letter Latin word in body paragraphs AFTER the first — the foreign
  // identity is being repeated past its single allowed first mention. needs_review.
  if (LATIN_WORD_RE.test(foldDigits(restBody))) {
    review.add("editorial_english_name_repeated_after_first");
  }
  LATIN_WORD_RE.lastIndex = 0;

  // Same English token appearing ≥2 times across title+excerpt+summary+body
  // (should appear once, at first mention only). Counts EVERY occurrence, inside
  // or outside a gloss, so a name glossed twice — including once in the excerpt
  // and again in the body — is still caught. needs_review.
  {
    const counts = new Map<string, number>();
    for (const tok of foldDigits(`${title}\n${excerpt}\n${summary}\n${body}`).match(LATIN_WORD_RE) ?? []) {
      const k = tok.toLowerCase();
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    if ([...counts.values()].some((c) => c >= 2)) review.add("editorial_english_name_repeated_after_first");
  }

  // Excess DISTINCT English is measured ONLY over Latin words that fall OUTSIDE
  // an approved first-mention parenthetical gloss (plus any Latin in the title,
  // where glosses are never allowed). A clean Arabic-first article that carries
  // one short Latin identity per name inside parentheses — e.g.
  // «سني فارماتيك (Sunny Pharmtech)» — contributes nothing here, so a correct
  // first-mention gloss is no longer mistaken for unnecessary English. advisory.
  {
    const distinctOutside = new Set<string>();
    const spans = parenSpans(visible);
    const foldedVisible = foldDigits(visible);
    let m: RegExpExecArray | null;
    LATIN_WORD_RE.lastIndex = 0;
    while ((m = LATIN_WORD_RE.exec(foldedVisible)) !== null) {
      if (!insideAnySpan(m.index, spans)) distinctOutside.add(m[0].toLowerCase());
    }
    LATIN_WORD_RE.lastIndex = 0;
    for (const tok of foldDigits(title).match(LATIN_WORD_RE) ?? []) {
      distinctOutside.add(tok.toLowerCase());
    }
    if (distinctOutside.size > EDITORIAL_MAX_ENGLISH_TOKENS) advisory.add("editorial_excess_english_tokens");
  }

  // A first-mention gloss should be a short identity (a name), not a phrase:
  // flag when the first-paragraph parenthetical carries more Latin words than a
  // name needs. Keeps the exact-identity requirement intact while catching
  // excessive foreign text stuffed inside the parentheses. advisory.
  {
    const spans = parenSpans(firstPara);
    for (const s of spans) {
      const inner = firstPara.slice(s.start, s.end);
      if ((foldDigits(inner).match(LATIN_ALPHA_RE) ?? []).length > EDITORIAL_MAX_PAREN_LATIN_WORDS) {
        advisory.add("editorial_excess_english_in_parenthetical");
        break;
      }
    }
  }

  // Unnecessary regulatory labels/abbreviations (USP/NDC/Lot/Inc/LLC/Ltd).
  {
    const up = foldDigits(`${title}\n${visible}\n${summary}`).toUpperCase();
    for (const label of UNNECESSARY_LABELS) {
      if (new RegExp(`(?:^|[^A-Z])${label}(?:$|[^A-Z])`).test(up)) {
        review.add("editorial_unnecessary_label");
        break;
      }
    }
  }

  // --- Excess verification-only identifiers in the visible story -------------
  const visibleNorm = normalizeForCompare(`${title}\n${visible}`);
  let idCount = 0;
  for (const ent of opts.verificationOnly ?? []) {
    const e = normalizeForCompare(ent);
    if (e && visibleNorm.includes(e)) idCount++;
  }
  idCount += (foldDigits(`${title}\n${body}`).match(CODE_TOKEN_RE) ?? []).length;
  if (idCount > EDITORIAL_MAX_IDENTIFIERS) review.add("editorial_excess_identifiers");

  // --- First impression ------------------------------------------------------
  const bodyNorm = normalizePhrase(body);
  if (PRESS_RELEASE_OPENERS.some((op) => bodyNorm.startsWith(op) || bodyNorm.startsWith(`و${op}`))) {
    review.add("editorial_press_release_opening");
  }

  // Literal-translation / press-release phrases.
  const allNorm = normalizePhrase(`${title} ${excerpt} ${summary} ${body}`);
  if (FLAGGED_PHRASES.some((p) => allNorm.includes(normalizePhrase(p)))) {
    review.add("editorial_promo_or_literal_phrase");
  }
  if (allNorm.includes("طوعي") && allNorm.includes("شامل")) {
    review.add("editorial_promo_or_literal_phrase");
  }

  // Unnecessary "voluntary" framing (طوعاً / طوعي …) — regulatory language a
  // reader-first story does not need. needs_review. Matched as whole tokens over
  // the normalized visible story so a substring inside another word cannot fire.
  {
    const tokens = new Set(
      normalizePhrase(`${title} ${excerpt} ${summary} ${body}`)
        .replace(/[^\u0600-\u06FF\s]/g, " ")
        .split(/\s+/)
        .filter(Boolean),
    );
    if (VOLUNTARY_TOKENS.some((t) => tokens.has(normalizePhrase(t)))) {
      review.add("editorial_unnecessary_voluntary");
    }
  }

  // --- Distinct excerpt / summary --------------------------------------------
  const exNorm = normalizeForCompare(excerpt);
  const tiNorm = normalizeForCompare(title);
  if (exNorm && tiNorm && (exNorm === tiNorm || jaccard(exNorm, tiNorm) >= 0.9)) {
    blocking.add("editorial_excerpt_equals_title");
  } else if (exNorm && tiNorm && jaccard(exNorm, tiNorm) >= EDITORIAL_DUP_JACCARD) {
    review.add("editorial_excerpt_duplicates_title");
  }
  {
    const firstPara = normalizeForCompare(body.split(/\n\s*\n/)[0] ?? "");
    if (exNorm && firstPara && (firstPara.includes(exNorm) || jaccard(exNorm, firstPara) >= EDITORIAL_DUP_JACCARD)) {
      review.add("editorial_excerpt_duplicates_opening");
    }
    const suNorm = normalizeForCompare(summary);
    if (suNorm && exNorm && (suNorm === exNorm || jaccard(suNorm, exNorm) >= EDITORIAL_DUP_JACCARD)) {
      review.add("editorial_summary_duplicates_excerpt");
    }
  }

  // --- Length / paragraphs ---------------------------------------------------
  const band = PROFILE_WORD_BANDS[profile];
  if (body && countWords(body) > band.max) review.add("editorial_body_over_length");
  for (const para of body.split(/\n\s*\n/)) {
    if (countWords(para) > EDITORIAL_MAX_PARAGRAPH_WORDS) {
      advisory.add("editorial_paragraph_too_long");
      break;
    }
  }

  // --- Arabic number/noun agreement (deterministic, bounded lists) ----------
  // Numbers 3–10 take the OPPOSITE gender form of the counted noun's singular:
  //   feminine plural (دفعات/حالات/شركات)   → bare form  "ثلاث دفعات"  (ثلاثة = WRONG)
  //   masculine plural (أدوية/مرضى/مستشفيات) → taa form   "ثلاثة أدوية" (ثلاث  = WRONG)
  // We flag ONLY the two well-known wrong pairings, over the whole visible story
  // (title+excerpt+summary+body), using token adjacency so a number prefix like
  // "ليست" cannot trigger a false match. This is NOT a general grammar engine.
  {
    const words = normalizePhrase(`${title} ${excerpt} ${summary} ${body}`)
      .replace(/[^\u0600-\u06FF\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean);
    for (let i = 0; i < words.length - 1; i++) {
      const num = words[i];
      const noun = words[i + 1];
      const mascNumFemPlural = MASC_NUMBER_WORDS.includes(num) && FEM_PLURALS.includes(noun);
      const femNumMascPlural = FEM_NUMBER_WORDS.includes(num) && MASC_PLURALS.includes(noun);
      if (mascNumFemPlural || femNumMascPlural) {
        review.add("editorial_arabic_agreement_error");
        break;
      }
    }
  }

  // --- Repeated entity (advisory) -------------------------------------------
  {
    const wc = new Map<string, number>();
    for (const w of normalizeForCompare(body).split(" ")) {
      if (w.length >= 4 && /[\u0600-\u06FF]/.test(w)) wc.set(w, (wc.get(w) ?? 0) + 1);
    }
    if ([...wc.values()].some((c) => c >= 4)) advisory.add("editorial_repeated_entity");
  }

  // --- Reader-value & regulatory-detail discipline (E1.7) -------------------
  // Only the fast, action-oriented profiles. A verified fact may legitimately
  // stay in the fact packet without appearing here; these warnings flag detail
  // that does not serve one of the five reader-value purposes, plus the two
  // "must-not-be-ready" integrity issues: mis-attributed recall action and
  // unsupported absolute reassurance (both need the verified source to judge).
  if (profile === "safety_alert" || profile === "quick_news") {
    const visNorm = normalizePhrase(visible);
    const allNormRV = normalizePhrase(`${title} ${excerpt} ${summary} ${body}`);
    const lowerVisible = foldDigits(`${title}\n${visible}\n${summary}`).toLowerCase();

    // Clinical-use explanation — usually unnecessary in a short safety alert.
    if (profile === "safety_alert" && CLINICAL_USE_PATTERNS.some((p) => visNorm.includes(p))) {
      review.add("editorial_unnecessary_clinical_use");
    }
    // Dosage strength / packaging detail.
    if (profile === "safety_alert" && STRENGTH_PACKAGING_PATTERNS.some((p) => allNormRV.includes(p))) {
      review.add("editorial_unnecessary_strength_or_packaging");
    }
    // A long chain of distinct complications where one clear risk would suffice.
    if (profile === "safety_alert") {
      const found = new Set<string>();
      for (const c of COMPLICATION_TERMS) if (visNorm.includes(c)) found.add(c);
      if (found.size > EDITORIAL_MAX_COMPLICATIONS) review.add("editorial_excess_complications");
    }
    // Batch / lot number in a general-reader article.
    if (BATCH_PHRASES.some((p) => allNormRV.includes(p)) || BATCH_LATIN_RE.test(lowerVisible)) {
      review.add("editorial_unnecessary_batch_number");
    }
    // Unnecessary formal English identity wording (Hydrochloride / for Injection).
    if (FORMAL_ENGLISH_PATTERNS.some((p) => lowerVisible.includes(p))) {
      review.add("editorial_unnecessary_formal_english");
    }
    // Incorrect attribution: recall credited to the regulator when the verified
    // source shows a company initiated it. Requires the source to judge.
    if (opts.sourceText) {
      const srcNorm = normalizePhrase(opts.sourceText);
      const companyInitiated =
        /voluntar|طوع/.test(srcNorm) || (srcNorm.includes("شركة") && srcNorm.includes("سحب"));
      const creditsRegulator = REGULATOR_RECALL_PATTERNS.some((p) => allNormRV.includes(p));
      if (companyInitiated && creditsRegulator) review.add("editorial_incorrect_recall_attribution");
    }
    // Unsupported absolute reassurance ("آمنة"/"خالية من المخاطر" not in source).
    {
      // Tokenize on Arabic-letter boundaries so a sentence-final "آمنة." (with
      // trailing punctuation) is still recognised as the absolute-safe word.
      const arTokens = (s: string) => new Set(s.replace(/[^\u0600-\u06FF]+/g, " ").split(" ").filter(Boolean));
      const tokens = arTokens(allNormRV);
      const hasAbsolute =
        ABSOLUTE_SAFE_TOKENS.some((t) => tokens.has(t)) ||
        ABSOLUTE_SAFE_PHRASES.some((p) => allNormRV.includes(p));
      if (hasAbsolute && opts.sourceText) {
        const srcNorm = normalizePhrase(opts.sourceText);
        const srcTokens = arTokens(srcNorm);
        const srcSupports =
          srcNorm.includes("safe") ||
          ABSOLUTE_SAFE_TOKENS.some((t) => srcTokens.has(t)) ||
          ABSOLUTE_SAFE_PHRASES.some((p) => srcNorm.includes(p));
        if (!srcSupports) review.add("editorial_unsupported_reassurance");
      }
    }
    // Body longer than a fast reader needs (soft, advisory).
    const rvMax = EDITORIAL_READER_VALUE_MAX[profile];
    if (body && rvMax !== undefined && countWords(body) > rvMax) {
      advisory.add("editorial_body_exceeds_reader_value");
    }
  }

  return {
    blocking: [...blocking],
    needs_review: [...review],
    advisory: [...advisory],
  };
}

// -------------------------------------------------------------------------
// Single-attempt editor orchestrator + audit. The live model call and the real
// factual re-validator are injected; this stays pure and unit-testable.
// -------------------------------------------------------------------------

/** The editor should run on EVERY successfully validated writer draft — there is
 *  no skipping based on the absence of style warnings. Kept as an explicit,
 *  testable predicate so the invariant is documented in one place. */
export function shouldRunEditor(writerValidatedOk: boolean): boolean {
  return writerValidatedOk === true;
}

export type EditorCallResult =
  | { ok: true; content: string }
  | { ok: false; reason: string };
// `opts.strictRecovery` is set ONLY on the single formatting-only recovery call,
// so the transport can send a stricter "return valid JSON only" instruction.
// `opts.repair` is set ONLY on the single targeted editorial-repair call (E1.8):
// it carries the FIRST edited draft plus the exact deterministic issues to fix,
// so the transport sends the repair instruction over that draft (never the raw
// writer draft). The two are mutually exclusive — at most one second call occurs.
export type EditorCall = (
  model: string,
  opts?: {
    strictRecovery?: boolean;
    repair?: { draft: EditorArticle; issues: string[] };
  },
) => Promise<EditorCallResult>;

/**
 * Whether an editor FORMATTING/COMPLETION failure justifies exactly one recovery
 * call. Recoverable (formatting only): any strict-parser structural failure
 * (`editor_output_*` — invalid/truncated JSON, code-fence/extra-text/multiple-
 * objects, schema violation), an invalid completion state
 * (`editor_completed_invalid:*` — truncation/filter/tool_calls/other non-"stop"
 * finish), and an empty/non-string completion (`editor_empty_completion`). NOT
 * recoverable: transport failures (http/timeout/network/missing key) and every
 * non-formatting rejection (factual, dropped action/entity/risk, gate block, a
 * valid-but-poor edit) — those always retain the original with no retry.
 */
export function isRecoverableEditorFailure(reason: string): boolean {
  if (reason.startsWith("editor_output_")) return true;
  if (reason.startsWith("editor_completed_invalid")) return true;
  if (reason === "editor_empty_completion") return true;
  return false;
}

// The injected factual re-validator (index.ts wraps salmaWriter.validateArticle
// over the SAME verified source). ok:false carries the blocking rejection reason.
// On success it also returns the brand-stripped clean title so the accepted
// edited draft is stored exactly as the writer path stores its title.
export type EditorRevalidate = (
  article: EditorArticle,
) => { ok: true; readMinutes: number; cleanTitle: string } | { ok: false; reason: string };

// The compact editorial audit (E1.4A). Carries NO raw model text or secrets —
// only the decision trail an operator/editor needs.
export type EditorialAudit = {
  editor_attempted: boolean;
  editor_model_requested: string | null;
  editor_model_used: string | null;
  editor_output_parsed: boolean;
  edited_draft_accepted: boolean;
  final_draft_source: "original" | "first_edit" | "repaired_edit";
  editorial_verdict: EditorVerdict;
  // The model's own self-reported verdict (recorded but NOT authoritative).
  model_editorial_verdict: EditorVerdict | null;
  issues_found: string[];
  changes_made: string[];
  factual_revalidation_result: "passed" | "failed" | "not_run";
  editor_rejection_reason: string | null;
  // Deterministic gate detail (helpful for tuning; not persisted by default).
  editorial_blocking: string[];
  editorial_review: string[];
  editorial_advisory: string[];
  // Recovery trail (E1.6): how many editor calls were made (max 2), why the
  // first attempt failed (formatting only), whether a formatting-only recovery
  // was attempted and whether it produced an accepted edit, and the final
  // editor failure reason when the article was not accepted.
  editor_attempts: number;
  first_attempt_failure_reason: string | null;
  recovery_attempted: boolean;
  recovery_succeeded: boolean;
  final_editor_failure_reason: string | null;
  // Targeted editorial-repair trail (E1.8). The single second call is EITHER a
  // formatting recovery OR an editorial repair, never both — `second_attempt_type`
  // records which (or "none"). `repair_issues` are the deterministic issues the
  // repair was asked to fix; `repair_succeeded` is true only when a repaired draft
  // was chosen AND it cleared all repairable issues. `first_valid_edited_draft_
  // available` is true whenever any factually-valid editor draft existed (so the
  // original is retained ONLY when no valid editor draft was produced).
  second_attempt_type: "none" | "formatting_recovery" | "editorial_repair";
  repair_issues: string[];
  repair_succeeded: boolean;
  first_valid_edited_draft_available: boolean;
  final_editorial_verdict: EditorVerdict;
  final_rejection_reason: string | null;
};

export type EditorPassResult = {
  article: EditorArticle;
  readMinutes: number;
  audit: EditorialAudit;
};

/** Which official actions present in BOTH the source and the original draft were
 *  dropped by the edited draft (a required-action removal — never allowed). */
export function droppedRequiredActions(
  original: EditorArticle,
  edited: EditorArticle,
  packet: EditorFactPacket,
): string[] {
  const required = new Set(
    extractOfficialActions(original.body).filter((a) => packet.requiredActions.includes(a)),
  );
  const kept = new Set(extractOfficialActions(edited.body));
  return [...required].filter((a) => !kept.has(a));
}

/** Reader-essential entities the original surfaced but the edited draft dropped. */
function droppedEssentialEntities(
  original: EditorArticle,
  edited: EditorArticle,
  packet: EditorFactPacket,
): string[] {
  const origNorm = normalizeForCompare(`${original.title}\n${original.body}`);
  const editNorm = normalizeForCompare(`${edited.title}\n${edited.body}`);
  const dropped: string[] = [];
  for (const ent of packet.readerEssential) {
    // Compare on the ESSENTIAL identity (formal/regulatory suffixes removed) so
    // an editor that correctly drops "for Injection, USP" while keeping the core
    // name is not treated as having dropped the entity.
    const e = normalizeForCompare(stripFormalSuffixes(ent));
    if (e && origNorm.includes(e) && !editNorm.includes(e)) dropped.push(ent);
  }
  return dropped;
}

/** For a safety alert, did the edit strip ALL risk vocabulary the original had? */
function droppedAllRisk(
  original: EditorArticle,
  edited: EditorArticle,
  packet: EditorFactPacket,
): boolean {
  if (packet.profile !== "safety_alert") return false;
  const o = normalizePhrase(original.body);
  const e = normalizePhrase(edited.body);
  const origHasRisk = RISK_TERMS.some((r) => o.includes(normalizePhrase(r)));
  const editHasRisk = RISK_TERMS.some((r) => e.includes(normalizePhrase(r)));
  return origHasRisk && !editHasRisk;
}

/**
 * Run the editorial-rewrite over an already factually-validated writer draft.
 * At most TWO calls to `call` are made: the first, plus exactly ONE second call
 * that is EITHER a formatting recovery OR a targeted editorial repair — never
 * both (they are mutually exclusive, so no more than two calls occur):
 *   - formatting recovery fires ONLY when the first response is malformed /
 *     truncated / structurally invalid (see isRecoverableEditorFailure);
 *   - editorial repair fires ONLY when the first response is factually valid but
 *     the deterministic gate raises repairable editorial issues (English
 *     placement, literal/regulatory wording, unnecessary labels/voluntary,
 *     number agreement, press-release openings). It re-sends the FIRST edited
 *     draft with the exact issues to fix, then re-runs factual validation and
 *     the gate. There is no loop and no Gemini fallback.
 *
 * A factually-valid edit is ALWAYS retained (E1.8): factual re-validation +
 * protected-fact preservation (required actions, essential entities, safety
 * risk) are the only bars to retention. The gate never rejects — it shapes the
 * verdict and triggers the one repair. The repaired draft replaces the first
 * only when it strictly reduces the repairable issues AND keeps every protected
 * fact; a repair that changes/removes a protected fact or fails to format is
 * discarded and the first valid edit is retained. The original writer draft is
 * used ONLY when NO factually-valid editor draft was produced. The verdict is
 * "ready" only when the chosen draft's gate is clean; any blocking/needs_review
 * warning ⇒ needs_human_review.
 */
export async function runEditorPass(args: {
  profile: WritingProfile;
  model: string;
  original: { article: EditorArticle; readMinutes: number };
  packet: EditorFactPacket;
  call: EditorCall;
  revalidate: EditorRevalidate;
  verificationOnly?: string[];
}): Promise<EditorPassResult> {
  const { profile, model, original, packet, call, revalidate } = args;

  const keepOriginal = (
    reason: string,
    extra: Partial<EditorialAudit>,
  ): EditorPassResult => ({
    article: original.article,
    readMinutes: original.readMinutes,
    audit: {
      editor_attempted: true,
      editor_model_requested: model,
      editor_model_used: extra.editor_model_used ?? null,
      editor_output_parsed: extra.editor_output_parsed ?? false,
      edited_draft_accepted: false,
      final_draft_source: "original",
      editorial_verdict: "needs_human_review",
      model_editorial_verdict: extra.model_editorial_verdict ?? null,
      issues_found: extra.issues_found ?? [],
      changes_made: extra.changes_made ?? [],
      factual_revalidation_result: extra.factual_revalidation_result ?? "not_run",
      editor_rejection_reason: reason,
      editorial_blocking: extra.editorial_blocking ?? [],
      editorial_review: extra.editorial_review ?? [],
      editorial_advisory: extra.editorial_advisory ?? [],
      editor_attempts: extra.editor_attempts ?? 1,
      first_attempt_failure_reason: extra.first_attempt_failure_reason ?? null,
      recovery_attempted: extra.recovery_attempted ?? false,
      recovery_succeeded: extra.recovery_succeeded ?? false,
      final_editor_failure_reason: extra.final_editor_failure_reason ?? reason,
      second_attempt_type: extra.second_attempt_type ?? "none",
      repair_issues: extra.repair_issues ?? [],
      repair_succeeded: extra.repair_succeeded ?? false,
      first_valid_edited_draft_available: extra.first_valid_edited_draft_available ?? false,
      final_editorial_verdict: "needs_human_review",
      final_rejection_reason: extra.final_rejection_reason ?? reason,
    },
  });

  // A single evaluated attempt (one model call + full evaluation), reused for the
  // first pass, the one formatting recovery, and the one editorial repair. It no
  // longer decides retention — it only classifies its own outcome:
  //   - "valid"            → parsed + factually valid + protected facts preserved.
  //                          A RETAINABLE edit; its gate may still carry warnings
  //                          (blocking no longer forces the original back — E1.8).
  //   - "factual_rejected" → parsed but failed factual re-validation or a
  //                          protected-fact check (action/entity/risk), or a
  //                          non-recoverable transport failure. Never retained.
  //   - "format_failed"    → the call or strict parse failed for a formatting/
  //                          completion reason; eligible for ONE formatting recovery.
  type ValidOutcome = {
    kind: "valid";
    article: EditorArticle;
    readMinutes: number;
    gate: EditorialGateResult;
    common: {
      editor_model_used: string;
      model_editorial_verdict: EditorVerdict;
      issues_found: string[];
      changes_made: string[];
    };
  };
  type AttemptOutcome =
    | ValidOutcome
    | { kind: "factual_rejected"; reason: string; extra: Partial<EditorialAudit> }
    | { kind: "format_failed"; reason: string; extra: Partial<EditorialAudit> };

  // The second call is EITHER a formatting recovery OR an editorial repair — never
  // both. `mode` selects which prompt the transport builds via `call` opts.
  type AttemptMode =
    | { type: "normal" }
    | { type: "formatting_recovery" }
    | { type: "editorial_repair"; draft: EditorArticle; issues: string[] };

  const attempt = async (mode: AttemptMode): Promise<AttemptOutcome> => {
    // 1) Editor call. Formatting recovery and editorial repair send distinct
    //    transport opts; a normal first pass sends none. A transport failure is
    //    non-recoverable; a completion-state failure is a formatting failure.
    const callOpts =
      mode.type === "formatting_recovery"
        ? { strictRecovery: true }
        : mode.type === "editorial_repair"
          ? { repair: { draft: mode.draft, issues: mode.issues } }
          : undefined;
    const res = await call(model, callOpts);
    if (!res.ok) {
      const reason = `editor_call_failed:${res.reason}`;
      const extra: Partial<EditorialAudit> = { editor_output_parsed: false };
      return isRecoverableEditorFailure(res.reason)
        ? { kind: "format_failed", reason, extra }
        : { kind: "factual_rejected", reason, extra };
    }

    // 2) Strict parse — every parser failure is a structural/formatting failure.
    const parsed = parseEditorOutput(res.content);
    if (!parsed.ok) {
      return {
        kind: "format_failed",
        reason: parsed.error,
        extra: { editor_model_used: model, editor_output_parsed: false },
      };
    }
    const out = parsed.output;
    const editedArticle: EditorArticle = {
      title: out.title,
      excerpt: out.excerpt,
      summary: out.summary,
      body: out.body,
    };
    const common = {
      editor_model_used: model,
      model_editorial_verdict: out.editorial_verdict,
      issues_found: out.issues_found,
      changes_made: out.changes_made,
    };
    const auditCommon: Partial<EditorialAudit> = {
      editor_model_used: model,
      editor_output_parsed: true,
      model_editorial_verdict: out.editorial_verdict,
      issues_found: out.issues_found,
      changes_made: out.changes_made,
    };

    // 3) Factual re-validation of the edited version (never retried on failure).
    const rev = revalidate(editedArticle);
    if (!rev.ok) {
      return { kind: "factual_rejected", reason: rev.reason, extra: { ...auditCommon, factual_revalidation_result: "failed" } };
    }
    // Store the brand-stripped clean title (as the writer path does), then run
    // all remaining protected-fact and editorial-gate checks over that form.
    const finalArticle: EditorArticle = { ...editedArticle, title: rev.cleanTitle || editedArticle.title };

    // 4) Protected-fact preservation: required actions, essential entities, risk.
    //    A repair that changes/removes any of these is a factual rejection, so the
    //    caller retains the first valid edit instead of the regressing repair.
    const droppedActions = droppedRequiredActions(original.article, finalArticle, packet);
    if (droppedActions.length) {
      return {
        kind: "factual_rejected",
        reason: `editor_dropped_required_action:${droppedActions[0]}`,
        extra: { ...auditCommon, factual_revalidation_result: "passed" },
      };
    }
    const droppedEntities = droppedEssentialEntities(original.article, finalArticle, packet);
    if (droppedEntities.length) {
      return {
        kind: "factual_rejected",
        reason: `editor_dropped_essential_entity:${droppedEntities[0]}`,
        extra: { ...auditCommon, factual_revalidation_result: "passed" },
      };
    }
    if (droppedAllRisk(original.article, finalArticle, packet)) {
      return { kind: "factual_rejected", reason: "editor_dropped_risk", extra: { ...auditCommon, factual_revalidation_result: "passed" } };
    }

    // 5) Deterministic editorial gate. A factually-valid edit is ALWAYS retainable
    //    (E1.8): the gate no longer rejects — it only shapes the verdict and, when
    //    it raises repairable warnings, triggers the one editorial-repair call.
    const gate = editorialGate(finalArticle, profile, {
      verificationOnly: args.verificationOnly,
      sourceText: packet.sourceText,
    });
    return { kind: "valid", article: finalArticle, readMinutes: rev.readMinutes, gate, common };
  };

  // Build the final accepted result from a chosen factually-valid edit. The
  // verdict is deterministic: any blocking OR needs_review gate warning ⇒ human
  // review; a clean gate ⇒ ready. The model's own verdict is recorded, never
  // authoritative.
  const buildAccepted = (
    chosen: ValidOutcome,
    overlay: {
      final_draft_source: "first_edit" | "repaired_edit";
      second_attempt_type: EditorialAudit["second_attempt_type"];
      editor_attempts: number;
      first_attempt_failure_reason: string | null;
      recovery_attempted: boolean;
      recovery_succeeded: boolean;
      repair_issues: string[];
      repair_succeeded: boolean;
      final_rejection_reason: string | null;
    },
  ): EditorPassResult => {
    const gate = chosen.gate;
    const verdict: EditorVerdict =
      gate.blocking.length || gate.needs_review.length ? "needs_human_review" : "ready";
    return {
      article: chosen.article,
      readMinutes: chosen.readMinutes,
      audit: {
        editor_attempted: true,
        editor_model_requested: model,
        editor_model_used: chosen.common.editor_model_used,
        editor_output_parsed: true,
        edited_draft_accepted: true,
        final_draft_source: overlay.final_draft_source,
        editorial_verdict: verdict,
        model_editorial_verdict: chosen.common.model_editorial_verdict,
        issues_found: chosen.common.issues_found,
        changes_made: chosen.common.changes_made,
        factual_revalidation_result: "passed",
        editor_rejection_reason: null,
        editorial_blocking: gate.blocking,
        editorial_review: gate.needs_review,
        editorial_advisory: gate.advisory,
        editor_attempts: overlay.editor_attempts,
        first_attempt_failure_reason: overlay.first_attempt_failure_reason,
        recovery_attempted: overlay.recovery_attempted,
        recovery_succeeded: overlay.recovery_succeeded,
        final_editor_failure_reason: overlay.final_rejection_reason,
        second_attempt_type: overlay.second_attempt_type,
        repair_issues: overlay.repair_issues,
        repair_succeeded: overlay.repair_succeeded,
        first_valid_edited_draft_available: true,
        final_editorial_verdict: verdict,
        final_rejection_reason: overlay.final_rejection_reason,
      },
    };
  };

  // ---- First attempt --------------------------------------------------------
  const first = await attempt({ type: "normal" });

  // Formatting-only failure ⇒ exactly ONE formatting recovery (no editorial
  // repair afterwards; the two-call budget is spent).
  if (first.kind === "format_failed") {
    const recovered = await attempt({ type: "formatting_recovery" });
    if (recovered.kind === "valid") {
      return buildAccepted(recovered, {
        final_draft_source: "first_edit",
        second_attempt_type: "formatting_recovery",
        editor_attempts: 2,
        first_attempt_failure_reason: first.reason,
        recovery_attempted: true,
        recovery_succeeded: true,
        repair_issues: [],
        repair_succeeded: false,
        final_rejection_reason: null,
      });
    }
    // Recovery failed too — no factually-valid editor draft exists, keep original.
    return keepOriginal(recovered.reason, {
      ...recovered.extra,
      editor_attempts: 2,
      first_attempt_failure_reason: first.reason,
      recovery_attempted: true,
      recovery_succeeded: false,
      second_attempt_type: "formatting_recovery",
      final_editor_failure_reason: recovered.reason,
      final_rejection_reason: recovered.reason,
    });
  }

  // Parsed but failed a factual / protected-fact check — never retried.
  if (first.kind === "factual_rejected") {
    return keepOriginal(first.reason, {
      ...first.extra,
      editor_attempts: 1,
      first_attempt_failure_reason: first.reason,
      recovery_attempted: false,
      recovery_succeeded: false,
      second_attempt_type: "none",
      final_editor_failure_reason: first.reason,
      final_rejection_reason: first.reason,
    });
  }

  // ---- First attempt produced a factually-valid edit ------------------------
  const firstIssues = repairableEditorialIssues(first.gate);
  if (firstIssues.length === 0) {
    // No repairable editorial issue — accept the first valid edit as-is. (Any
    // non-repairable blocking/review warning still yields needs_human_review.)
    return buildAccepted(first, {
      final_draft_source: "first_edit",
      second_attempt_type: "none",
      editor_attempts: 1,
      first_attempt_failure_reason: null,
      recovery_attempted: false,
      recovery_succeeded: false,
      repair_issues: [],
      repair_succeeded: false,
      final_rejection_reason: null,
    });
  }

  // ---- Exactly ONE targeted editorial repair over the FIRST edited draft -----
  const repair = await attempt({ type: "editorial_repair", draft: first.article, issues: firstIssues });
  if (repair.kind === "valid") {
    const repairIssues = repairableEditorialIssues(repair.gate);
    // Prefer the repaired draft only if it STRICTLY reduces the repairable issues;
    // otherwise keep the first valid edit (never regress on a repair).
    if (repairIssues.length < firstIssues.length) {
      return buildAccepted(repair, {
        final_draft_source: "repaired_edit",
        second_attempt_type: "editorial_repair",
        editor_attempts: 2,
        first_attempt_failure_reason: null,
        recovery_attempted: false,
        recovery_succeeded: false,
        repair_issues: firstIssues,
        repair_succeeded: repairIssues.length === 0,
        final_rejection_reason: null,
      });
    }
    return buildAccepted(first, {
      final_draft_source: "first_edit",
      second_attempt_type: "editorial_repair",
      editor_attempts: 2,
      first_attempt_failure_reason: null,
      recovery_attempted: false,
      recovery_succeeded: false,
      repair_issues: firstIssues,
      repair_succeeded: false,
      final_rejection_reason: null,
    });
  }

  // Repair changed/removed a protected fact or failed to format: reject the
  // repair and retain the first factually-valid edit (needs_human_review).
  return buildAccepted(first, {
    final_draft_source: "first_edit",
    second_attempt_type: "editorial_repair",
    editor_attempts: 2,
    first_attempt_failure_reason: null,
    recovery_attempted: false,
    recovery_succeeded: false,
    repair_issues: firstIssues,
    repair_succeeded: false,
    final_rejection_reason: repair.reason,
  });
}
