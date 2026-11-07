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
  ambiguousNumericFigures,
  arabicCountryEquivalents,
  arabicEntityPresent,
  arabicMatchTokens,
  HEADLINE_OVERSTATEMENT_CUES,
  NATURAL_ARABIC_LINES,
  NO_INVENTED_LATIN_RULE,
  RATIO_RULE,
  sourceOrderCorrelation,
  classifyEntityVisibility,
  countWords,
  dbaAliases,
  EXCERPT_DEFINITION,
  excerptDuplicatesLead,
  extractOfficialActions,
  foldDigits,
  foreignEssentialNameStatus,
  glossedRendering,
  normalizeForCompare,
  PROFILE_WORD_BANDS,
  regulatorGroup,
  regulatorPresent,
  stripFormalSuffixes,
  suspectGlossPairs,
  type WritingProfile,
} from "./salmaWriter.ts";
import { buildGlossaryPromptBlock } from "./glossaryAr.ts";

export const EDITOR_PROMPT_VERSION = "e2.3-salma-editor" as const;

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
// e2.0: quick_news is retired from selection (salmaWriter.selectProfile); a
// stored/explicit quick_news value is edited exactly like standard_news.
const STANDARD_NEWS_EDIT_GUIDANCE =
  "خبر صحي: اجعل المقدّمة تحمل الخبر وأهميته، ووضّح ما تغيّر ومن المتأثّر. لا تُضِف سياقاً إلا إذا كان القارئ لا يفهم الخبر بدونه، واحذف الحشو والتكرار وكل جملة لا تُضيف للقارئ شيئاً.";

const PROFILE_EDIT_GUIDANCE: Record<WritingProfile, string> = {
  quick_news: STANDARD_NEWS_EDIT_GUIDANCE,
  standard_news: STANDARD_NEWS_EDIT_GUIDANCE,
  regulation_or_service:
    "قرار/لائحة/خدمة: اذكر ما تغيّر ومن المتأثّر، واذكر متى توفّرت وكانت مهمّة للقارئ تاريخ السريان والإجراء المطلوب والمهلة/الرسوم/الأهلية، بشرح عربي واضح بدل النصّ القانوني.",
  safety_alert:
    "تحذير سلامة قصير موجّه للقارئ العام: يجب أن تخدم كل جملة ظاهرة واحدة على الأقل من الوظائف الخمس (ما الذي حدث؟ لماذا يهمّ؟ من المتأثّر؟ ما الإجراء المطلوب؟ ما أهمّ نتيجة مؤكّدة؟). أبقِ هوية المنتج المفهومة وسبب التحذير وأهمّ خطر مؤكّد بلغة بسيطة والإجراء الصحيح للمريض والمنشأة وهل سُجّلت إصابات. أبقِ سطراً واحداً يوضّح استخدام المنتج كما يذكره المصدر حتى يعرف القارئ هل يعنيه، والفئات الأكثر عرضة للخطر، ومن لا يشمله الخطر أو مستوى الخطر على عامة الناس حين يذكره المصدر. احذف عادةً: قوائم الاستخدامات العلاجية المطوّلة، وقيم الجرعة/التركيز، ووصف العبوة أو القارورة أحادية الجرعة، وأرقام الدفعات، وأكواد NDC/التسجيل، وتواريخ التوزيع/الصلاحية، والتسميات التنظيمية الملحقة بالاسم الأجنبي وحدها (USP وNDC وLot وInc وLLC وLtd وكلمات الشكل الصيدلاني مثل for Injection) — لا أي جزء من هوية المنتج نفسها، بما في ذلك Hydrochloride — وقوائم المضاعفات المطوّلة، ولغة إجراءات السحب الرسمية، وكلمة «طوعاً» حين لا تضيف قيمة. لا تُبقِ الدفعة/التركيز إلا إذا احتاجها القارئ للتعرّف على المنتج المتأثّر.",
  research_study:
    "دراسة: ابدأ بالنتيجة الأساسية ومعناها العملي، واذكر عند أهمّيتها ما دُرِس ونوع الدراسة وحجم العيّنة وأهمّ حدّ لها. صرّح دائماً بما إذا كانت النتيجة من تجارب مخبرية أو على حيوانات أو على بشر، وميّز بين الارتباط والسببية، ولا تعمّم النتيجة المحدّدة إلى ادّعاء طبي أوسع. أبقِ النتيجة الأساسية ونتيجتين أو ثلاث نتائج ثانوية على الأكثر — تلك التي تغيّر فهم القارئ أو قراره. احذف DOI والمعرّفات الداخلية وقوائم المؤلّفين الطويلة.",
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
    "اسم أجنبي ورد بالإنجليزية فقط في أول فقرة: إن كان له تعريب راسخ لا لبس فيه فاكتبه بالعربية أولاً ثم ضع الأصل الإنجليزي بين قوسين مرّة واحدة؛ وإلا فلا تخترع تهجئة عربية، وأبقِ الاسم اللاتيني مسبوقاً بوصف عربي.",
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
  // P4R-9: the excerpt restates the lead — rewrite it under the e2.3 definition.
  editorial_excerpt_duplicates_opening:
    "المقتطف يكرّر المقدّمة: أعد كتابة المقتطف وحده ليجيب عن سؤال «لماذا يهمّني هذا؟» — العاقبة أو ما على المحكّ للقارئ كما يذكره المصدر — بينما تبقى المقدّمة للحدث نفسه. لا تُعِد استخدام أفعال المقدّمة ولا أسمائها الرئيسية إلا اسم الموضوع نفسه، ولا تُضِف عاقبة أو حقيقة لا يذكرها المصدر.",
};

// P4R-11: a restored item keeps its OWN source sentence's subject and scope.
export const RESTORE_SCOPE_RULE =
  "أعِده في جملته الخاصة بفاعله ونطاقه كما وردا في جملة المصدر نفسها، ولا تدمجه مع توصية أو إجراء موجّه إلى جمهور مختلف (مثل المرضى مقابل المنشآت الصحية أو الموزّعين).";

// P2-B7: Arabic labels for the official-action codes a targeted restore repair
// names (see salmaWriter OFFICIAL_ACTION_PATTERNS).
const ACTION_RESTORE_LABEL: Record<string, string> = {
  stop_use: "الإجراء المطلوب: التوقف عن استخدام المنتج المتأثر",
  avoid: "الإجراء المطلوب: تجنّب المنتج المتأثر",
  return: "الإجراء المطلوب: إعادة المنتج المتأثر",
  discard: "الإجراء المطلوب: التخلّص من المنتج المتأثر",
  check: "الإجراء المطلوب: التحقق من المنتج أو الدفعة",
  contact: "الإجراء المطلوب: التواصل مع الجهة المعنية",
  seek_help: "الإجراء المطلوب: مراجعة الطبيب أو طلب الرعاية الطبية",
};

// P2-B7: targeted restore-repair issue codes (the dropped item is the detail).
export const RESTORE_ACTION_PREFIX = "restore_missing_action:";
export const RESTORE_ENTITY_PREFIX = "restore_missing_entity:";

/** Arabic instruction for one repair issue code: the fixed editorial issues,
 *  plus the P2-B7 restore codes naming the exact missing item. */
export function repairIssueText(code: string): string {
  if (code.startsWith(RESTORE_ACTION_PREFIX)) {
    const a = code.slice(RESTORE_ACTION_PREFIX.length);
    return `أعِد إلى النص العنصر الناقص: ${ACTION_RESTORE_LABEL[a] ?? a} كما ورد في المصدر، دون تغيير أي شيء آخر. ${RESTORE_SCOPE_RULE}`;
  }
  if (code.startsWith(RESTORE_ENTITY_PREFIX)) {
    return `أعِد إلى النص العنصر الناقص: ${code.slice(RESTORE_ENTITY_PREFIX.length)} كما ورد في المصدر، دون تغيير أي شيء آخر. ${RESTORE_SCOPE_RULE}`;
  }
  return REPAIR_ISSUE_TEXT[code] ?? code;
}

// e2.0 (Phase 1) — the foreign-name gloss rule below tells the editor to keep the
// exact original identity INCLUDING chemical descriptors (e.g. Hydrochloride):
// the unchanged guards (stripFormalSuffixes → foreignEssentialNameStatus /
// droppedEssentialEntities) treat those as identity, so an edit that drops them
// is rejected. Only pure regulatory labels (USP/NDC/Lot/Inc/LLC/Ltd) and dosage-
// form words remain droppable, matching stripFormalSuffixes + UNNECESSARY_LABELS.
// Phase 2: reconcile FORMAL_ENGLISH_PATTERNS ("hydrochloride" → needs_review)
// with that identity rule, then revisit whether suffix dropping is wanted.
//
// e2.1 (prompt text only): the editor must actually edit — a mandatory final
// grammar/agreement + flow pass, event-first leads (never the monitoring/
// announcing body unless its identity IS the news), honest changes_made (state
// «لم يتغيّر النص» when the body is unchanged), and no forced changes to an
// already excellent draft. Same must-keep list and intelligent-compression
// rules as the writer; compression never removes a name the packet lists as
// reader-essential (droppedEssentialEntities is unchanged). Guards unchanged.
// e2.1.1: list compression uses a count only when the source states it
// (unsupported_number guard); «» reserved for real quotations (quote guard).
// e2.2 (P2 §Names policy — the only Phase 2 prompt change): same names policy
// as the writer; the editor may fix a transliteration ONLY by restoring the
// original Latin name (a changed rendering is flagged name_rendering_changed);
// keep "doing business as" direction, recall severity class, "as of DATE" on
// injury counts; lot/batch = دفعة/تشغيلة never عبوة; no «لم يذكر المصدر…».
// e2.3 (P4R remediation, prompt text): per-paragraph purpose test (cut a
// paragraph whose removal changes nothing the reader knows/does/concludes),
// paired with the unchanged don't-force-changes balance; the excerpt answers
// «لماذا يهمّني هذا؟» while the lead states the event; natural-Arabic lines and
// the ratio rule shared with the writer; the shared glossary + GCC regulator
// country on first mention; carve-out — no Latin form in the source ⇒ the Arabic
// name stands alone (invented_foreign_gloss blocks an invented one).
export function buildEditorInstructions(
  profile: WritingProfile,
  opts: { strictJsonRecovery?: boolean; repairIssues?: string[] } = {},
): string {
  const base = `أنت رئيس تحرير محترف للأخبار الصحية في منصة "سلمى". تتسلّم مسوّدة كتبها المحرّر الآلي عن قصّة مُتحقَّق منها، ومهمّتك إنتاج أفضل نسخة موجّهة للقارئ من القصّة نفسها دون تغيير أي حقيقة. (إصدار التعليمات: ${EDITOR_PROMPT_VERSION})

نوع المادة:
${PROFILE_EDIT_GUIDANCE[profile]}

مبدأ سلمى التحريري:
- الحقيقة اللازمة للتحقّق ليست بالضرورة حقيقة يجب أن تظهر في المقال. اجعل النصّ المرئي يجيب بسرعة: ماذا حدث؟ لماذا يهمّ؟ من المتأثّر؟ ما الذي يجب على القارئ أو الجهة فعله؟ وما أهمّ نتيجة أو حدّ مؤكّد؟ واترك التفاصيل التقنية للتحقّق فقط.

يمكنك: إعادة صياغة العنوان، وإعادة بناء المقدّمة، والاختصار، وحذف التكرار، وحذف المقدّمات والخاتمات المصطنعة، وحذف التفاصيل التنظيمية أو التقنية غير الضرورية، وتبسيط المصطلحات الطبية دون تغيير معناها، وتحسين الإيقاع والقواعد، وترتيب الحقائق حسب أهمّيتها للقارئ، ونقل الأسماء الأجنبية إلى العربية. القاعدة الحاكمة: كل جملة يجب أن تستحقّ مكانها — والطول تحدّده أهمية الخبر ومادته، لا عدد كلمات مستهدف.

التوازن: إذا كانت المسوّدة ممتازة أصلاً فلا تفرض عليها تغييرات. كل تغيير يجب أن يكون له غرض تحريري واضح يمكن إثباته (دقّة أو وضوح أو قواعد أو ترتيب أو حذف حشو)؛ والإبقاء على نصّ جيّد كما هو قرار تحريري صحيح، لا تقصير.

اختبار الغرض لكل فقرة (تفويض الحذف): اسأل عن كل فقرة: لو حُذفت، هل يتغيّر ما يعرفه القارئ أو ما يفعله أو ما يستنتجه؟ إن كان الجواب «لا» فاحذفها. هذا الاختبار يكمّل قاعدة التوازن ولا يناقضها: لا تحذف فقرة تحمل عنصراً من قائمة «ما لا يُحذف» أدناه، ولا تُجرِ تغييرات أخرى لا غرض لها.

الهدف: أكبر قدر من المعلومة المفيدة بأقلّ جهد قراءة. هذا ليس هدفاً لعدد الكلمات: لا تحذف أبداً حقيقة يحتاجها القارئ ليفهم الخبر بدقّة أو يفسّره تفسيراً آمناً.

ما لا يُحذف عند التبسيط أو الاختصار (لكل خبر، وبصرامة أكبر في تحذيرات السلامة وأخبار تفشّي الأمراض) — متى ورد في المصدر:
- تحذيرات السلامة.
- الفئات الأكثر عرضة للخطر.
- من لا يشمله الخطر، أو مستوى الخطر على عامة الناس، حين يذكره المصدر.
- الإجراءات التنظيمية والرسمية.
- القيود وعدم اليقين التي تغيّر ما يستنتجه القارئ أو يفعله.
- المقارنات المهمّة (بالعلاج الوهمي أو بالعلاج المعتاد أو بفترة سابقة).
- في سحب المنتجات وتنبيهاتها: سطر واحد يوضّح استخدام المنتج حتى يعرف القارئ هل يعنيه.
الاختصار يكون في: الشروح التقنية غير اللازمة، والصياغات المكرّرة، والحشو، والتفاصيل قليلة القيمة — لا في القائمة أعلاه. وإذا أسقطت المسوّدة عنصراً من هذه القائمة وارداً في المصدر فأعده.

الضغط الذكي:
- القائمة التي تزيد على ثلاثة عناصر اختصرها بصيغة غير رقمية («في عدة مناطق»، «في عدد من المستشفيات أبرزها…») أو بالإبقاء على أهمّ عناصرها، إلا إذا كان كل عنصر فيها يحتاجه القارئ بحدّ ذاته ليتصرّف أو ليعرف هل يعنيه الخبر (مثل المنتجات المتأثّرة في تحذير سلامة). استخدم عدداً دقيقاً فقط إذا ذكر المصدر هذا العدد نفسه نصاً، ولا تعدّ عناصر القائمة بنفسك: لا تذكر عدداً غير وارد نصاً في المصدر. ولا تختصر إلى عدد أي اسم ورد في «حقائق أساسية للقارئ (يجب أن تظهر)».
- الدراسات: أبقِ النتيجة الأساسية ومعها نتيجتان أو ثلاث نتائج ثانوية على الأكثر — تلك التي تغيّر فهم القارئ أو قراره.
- فئات الأدوية وآليات عملها: اشرحها بلغة القارئ («دواء يخفض…») بدل تسميتها حين لا يضيف الاسم العلمي للقارئ شيئاً. هذا لا يغيّر سياسة التعريب أولاً أدناه: اسم الدواء أو المنتج الأساسي يبقى بالعربية ثم بأصله الدقيق بين قوسين مرّة واحدة.
- التوقّعات والتقديرات تبقى منسوبة إلى أصحابها («يتوقع محللون»، «تقدّر الجهة») ولا تُكتب كأنها حقيقة واقعة؛ صحّح أي توقّع ورد في المسوّدة بصيغة الحقيقة.

يُمنع منعاً باتاً: إضافة أي حقيقة أو خلفية غير موجودة في المصدر، أو تغيير رقم أو تاريخ أو نتيجة أو خطر أو منتج أو جمهور أو إجراء أو قرار رسمي، أو المبالغة في الخطر أو التقليل منه، أو تحويل الارتباط إلى سببية، أو تعميم نتيجة محدّدة إلى ادّعاء طبي أوسع، أو طمس الفرق بين نتائج المختبر والحيوانات والبشر، أو حذف تحذير أساسي أو إجراء مطلوب، أو استخدام لغة مثيرة أو دعائية، أو اختلاق ترجمة عربية تُخطئ في تعريف الاسم.

سياسة التعريب أولاً (إلزامية لكل اسم أجنبي أساسي: الأدوية والشركات والمنتجات والجهات):
- اكتب الاسم بالعربية أولاً (تعريباً أو نقحرةً)، ثم ضَع الاسم الأجنبي الأصلي الدقيق بين قوسين عند أوّل ذكر فقط، هكذا: «سيكلوفوسفاميد (Cyclophosphamide)»، «سني فارماتيك (Sunny Pharmtech)»، «بابافيرين (Papaverine)»، «أمريكان ريجنت (American Regent)».
- لا تحذف الاسم الأجنبي الأصلي بالكامل مطلقاً: يجب أن يظهر الاسم الأصلي الدقيق مرّة واحدة بالضبط بين قوسين عند أوّل ذكر، حتى لا تضيع الهوية الدقيقة للمنتج أو الجهة، ولا تختصره أو تبدّله بصيغة قد تغيّر الهوية.
- استثناء: ${NO_INVENTED_LATIN_RULE} وإذا وجدت في المسوّدة قوساً لاتينياً لا يرد في المصدر فاحذفه.
- بعد أوّل ذكر، استخدم العربية وحدها، ولا تكرّر الاسم الإنجليزي ولا القوس التوضيحي في المقتطف أو بقية النص.
- العنوان عربي بالكامل: لا تضع أي حروف إنجليزية في العنوان إطلاقاً.
- علامتا التنصيص «» في المخرجات مخصّصتان حصراً للكلام المنقول حرفياً من المصدر. لا تضع بينهما أسماء أو أدوية أو مجلات أو برامج أو مصطلحات: الاسم المعرّب يُكتب مجرّداً بلا «»، والأصل الأجنبي بين قوسين () مرّة واحدة عند أوّل ذكر. (علامات «» في هذه التعليمات تحدّد الأمثلة فقط ولا تُنسخ إلى النص.)
- انسخ داخل القوس الهوية الأصلية الدقيقة كما وردت في المصدر دون حذف أي جزء منها، بما في ذلك الواصفات الكيميائية مثل Hydrochloride أو Sodium (مثل Cyclophosphamide أو Papaverine Hydrochloride أو American Regent). يجوز فقط إسقاط التسميات التنظيمية البحتة التي لا تدخل في الهوية مثل USP وNDC وLot وInc وLLC وLtd وكلمات الشكل الصيدلاني مثل for Injection. أبقِ الإنجليزية عند أضيق حدّ ممكن دون المساس بالهوية.
- انقل إلى العربية فقط الأسماء الراسخة أو التي لا لبس في نطقها. إذا لم يكن النطق مؤكّداً فلا تخترع تهجئة عربية أبداً: يبقى الاسم اللاتيني الأصلي مسبوقاً بوصف عربي، مثل: شركة Spectra Medical.
- إذا وجدت في المسوّدة تعريباً تشكّ في صحّته فلا تستبدله بتعريب آخر من عندك: الإصلاح الوحيد المسموح هو إعادة الاسم اللاتيني الأصلي كما ورد في المصدر مسبوقاً بوصف عربي. وإن كان التعريب سليماً فأبقِه كما هو حرفياً.
- صيغة «X doing business as Y» تبقى باتجاهها: X هي الجهة القانونية وY هو الاسم التجاري، ولا تعكسها.
- العنوان: إذا تعذّر نقل الاسم إلى العربية بأمان فاستخدم وصفاً عربياً عاماً (مثل «شركة أمريكية للأجهزة الطبية»)، ويبقى الاسم اللاتيني في النص.

${buildGlossaryPromptBlock()}

أمانة تفاصيل السحب والإصابات:
- أبقِ تصنيف خطورة السحب إن ذكره المصدر (مثل Class I أو «الفئة الأولى» أو «الأكثر خطورة») بصياغة عربية واضحة، ولا تحذفه عند الاختصار.
- أي عدد إصابات أو بلاغات أو وفيات مقرون في المصدر بتاريخ («حتى تاريخ…» / as of) يبقى مقروناً بالتاريخ نفسه.
- lot وbatch تعني «دفعة» أو «تشغيلة»، ولا تُترجم أبداً إلى «عبوة».
- لا تكتب في نص المقال «لم يذكر المصدر…» أو أي صيغة مشابهة: إذا لم يذكر المصدر معلومة فاحذف الحديث عنها ببساطة، واحذف أي جملة من هذا النوع وردت في المسوّدة.

قيمة القارئ أولاً (لكل خبر، وبصرامة أكبر في تحذيرات السلامة): يجب أن تخدم كل جملة ظاهرة واحدة على الأقل من الوظائف الخمس. احذف الجمل والتفاصيل التي لا تحسّن فعلياً أياً منها. الحقيقة المتحقَّقة قد تبقى في حزمة الحقائق دون أن تظهر في المقال المرئي، فليس كل ما تحقّقنا منه يلزم عرضه.

قلّل التفاصيل الطبية والتنظيمية غير الضرورية: اختر أهمّ خطر مؤكّد بلغة مفهومة للقارئ. فضّل «قد تسبب الجسيمات مضاعفات خطرة، من بينها انسداد الأوعية الدموية»، وتجنّب السلاسل المفصّلة غير الضرورية مثل «التهاب الوريد أو ورم حبيبي أو انسداد قد يصل إلى أحداث خثرية مهددة للحياة». أبقِ تفصيلاً أكبر فقط إذا كان حذفه يجعل التحذير مضلّلاً أو يمنع القارئ من التعرّف على المنتج المتأثّر.

الإبقاء الإلزامي على الخطر في تحذيرات السلامة: حين يذكر المصدر المُتحقَّق منه أو حزمة الحقائق خطراً طبياً مؤكّداً، يجب أن يُبقي المقال النهائي المرئي جملة واحدة موجزة على الأقل تشرح أهمّ خطر بلغة مفهومة للقارئ. التلخيص لتحذير السلامة قد يحذف التفاصيل التقنية الثانوية، لكنه يجب أن يُبقي دائماً على العناصر الخمسة: (1) ما الذي حدث، (2) المنتج أو الجمهور المتأثّر، (3) أهمّ خطر مؤكّد، (4) الإجراء المطلوب من المريض أو المنشأة، (5) هل سُجّلت إصابات أو آثار جانبية حين يذكر المصدر ذلك. يجوز تبسيط قائمة مضاعفات طويلة إلى الخطر الأهمّ والأكثر دلالة وحده، لكن يُمنع حذف كل معلومات الخطر لمجرّد تقصير المقال. لا تختلق خطراً ولا تقوّيه ولا تعمّمه ولا تبالغ فيه، وأبقِ أي مؤهِّل شدّة ورد في المصدر (مثل «في حالات خطرة» أو «قد يؤدي»). لا تستبدل الخطر بجملة فارغة مثل «قد يكون خطيراً» وحدها. النمط المفضّل: «وحذّرت من أن استخدام المنتج المتأثر قد يسبب تهيجاً أو تورماً موضعياً، وقد يؤدي في حالات خطرة إلى انسداد الأوعية الدموية».

أمانة نسبة الفعل: لا تنسب السحب إلى الجهة التنظيمية (مثل إدارة الغذاء والدواء) لمجرّد أنّ الخبر منشور على موقعها. ميّز بين الشركة التي بدأت السحب والجهة التي نشرته أو أعلنته أو نسّقته أو أشرفت عليه. لسحبٍ بدأته شركة ونشرته الجهة، اكتب «سحبت شركة أمريكان ريجنت…»، ولا تكتب «سحبت إدارة الغذاء والدواء…» إلا إذا نصّ المصدر صراحةً على أنّ الجهة نفسها هي من نفّذ السحب.

لا طمأنة مطلقة غير مدعومة: لا تحوّل «غير مشمولة بالسحب» أو «لم تتأثّر» أو «لم ترد بشأنها مشكلة» إلى «آمنة» أو «تظل آمنة» أو «خالية من المخاطر» ما لم يدعم المصدر صراحةً هذه الصيغة المطلقة.

الانطباع الأول:
- يجب أن ينقل العنوان والمقدّمة الخبر الحقيقي فوراً: الحدث أو التغيير أو المنفعة أو الخطر المهمّ أو الأثر العملي. لا تبدأ عادةً بـ«أعلنت الشركة» أو «كشفت الجهة» أو «أفاد بيان» أو «وفقاً للإشعار الرسمي» إلا إذا كانت هوية الجهة المعلِنة هي الخبر نفسه. ويجب ألا تكرّر المقدّمة العنوان بل تضيف ما يحتاجه القارئ لفهم الخبر؛ ولا تُضِف سياقاً إلا إذا كان القارئ لا يفهم الخبر بدونه.
- في الأخبار المباشرة وتحذيرات السلامة تحديداً، ابدأ بالفعل الحدثي المباشر لا بصيغة الإعلان: «سحبت شركة سني فارماتيك ثلاث دفعات...» أوضح وأقوى من «أعلنت شركة سني فارماتيك سحباً طوعياً...».
- المقدّمة تفتح بالحدث نفسه، لا بالجهة التي ترصده أو تتابعه أو تعلنه («تتابع الوزارة…»، «يراقب المركز…»، «أعلنت الهيئة…»)، إلا إذا كانت هوية الجهة نفسها هي الخبر. إذا افتتحت المسوّدة بالجهة فأعد كتابة المقدّمة إلزامياً: الحدث أولاً، ثم نسبته إلى الجهة.

مطابقة العدد للمعدود:
- مع جمع المؤنّث استخدم الصيغة المجرّدة: «ثلاث دفعات»، «ثلاث حالات»، «ثلاث شركات» — لا «ثلاثة دفعات».
- مع جمع المذكّر استخدم صيغة التاء المربوطة: «ثلاثة أدوية»، «ثلاثة مرضى»، «ثلاثة مستشفيات» — لا «ثلاث أدوية». صحّح أي خطأ في المطابقة وردَ في المسوّدة.

الجاذبية بلا إثارة: وضوح وقيمة وسرعة فهم وإيقاع طبيعي وترتيب مفيد — لا مبالغة ولا تخويف ولا يقين غير مدعوم ولا عناوين طُعم.

قابلية القراءة (مهمة تحريرية أساسية، دون المساس بأي حقيقة):
- بسّط الجمل الكثيفة متعددة التراكيب إلى جمل أقصر بفكرة واحدة، وقسّم الفقرات التي تتجاوز أربع جمل. حوّل أي صياغة أكاديمية أو تنظيمية إلى عربية فصحى صحفية بسيطة وطبيعية تنقل المعنى نفسه بدقّته، مع الإبقاء على كل تحفّظ يغيّر ما يجب أن يستنتجه القارئ أو يفعله.
- اشرح أولاً وسمِّ ثانياً: إن ورد مصطلح تقني دون شرح بسيط قبله فأعد صياغته (الوصف المفهوم أولاً، ثم المصطلح أو الاختصار بين قوسين عند الحاجة). لا تحذف مصطلحاً ضرورياً — اشرحه.
- احذف عبارات الحشو الآلية حيثما وردت بلا ضرورة: «من المهم الإشارة إلى»، «تجدر الإشارة»، «في هذا السياق»، «من جهة أخرى»، وصيغ «ما يجعل هذا مهماً ليس مجرد…» — واستبدلها بجملة مباشرة عملية. واحذف تكرار الشرح نفسه بصيغ مختلفة والتفاصيل التقنية الزائدة عن حاجة القارئ.
- انضباط العنوان: قوة ادّعاء العنوان يجب ألا تتجاوز أقوى ادّعاء مدعوم في النص. إن وجدت صيغة إحلال أو حسم («تحل محل»، «يقضي على»، «نهاية عصر»، «علاج نهائي») لا تدعمها الأدلة فأعد صياغة العنوان بصيغة أدق مثل «يضيف خياراً فموياً» أو «أول علاج فموي من فئة…».
- اللغة التنظيمية: لا تدمج موافقات جهات مختلفة في حكم واحد إذا اختلفت قوة الدليل لكل منها، وأبقِ الصياغة خاصة بكل جهة أو دولة بحسب ما يتوفر لها من أدلة في المصدر.
- الخاتمة: انتهِ حين تنتهي المعلومة. اختم بأسلوب «ما ننتظره الآن» العملي (ما الذي سيحدث لاحقاً أو ما البيانات الناقصة) فقط إذا ذكر المصدر أمراً محدّداً منتظراً فعلاً؛ وإلا فاحذف الخاتمة المصطنعة أو التلخيصية. لا تكتب خلاصة بحثية، وأبقِ كل تحفّظ يغيّر ما يجب أن يستنتجه القارئ أو يفعله.

المراجعة النهائية الإلزامية (قبل إخراج JSON، على العنوان والمقتطف والملخّص والنص):
- القواعد والمطابقة: راجع مطابقة الفعل لفاعله في التذكير والتأنيث («يتابع المركز» لا «تتابع المركز»، «أعلنت الوزارة» لا «أعلن الوزارة»)، ومطابقة الصفة لموصوفها والضمير لما يعود إليه، ومطابقة العدد للمعدود كما سبق. صحّح كل خطأ تجده، وأزل «» عن أي اسم أو مصطلح ليس كلاماً منقولاً.
- الانسياب والإيقاع: تأكّد أن الجمل تتتابع بربط طبيعي، وأن الجمل المتجاورة لا تبدأ بالصيغة نفسها، وأنه لا توجد جملة مقطوعة أو انتقال مفاجئ.
- ${RATIO_RULE}

${NATURAL_ARABIC_LINES}

المقتطف والملخّص لهما وظيفتان مختلفتان: ${EXCERPT_DEFINITION} والملخّص «باختصار» جملة واحدة قصيرة تضيف للقارئ شيئاً لا يقوله المقتطف (مثل ما ينبغي فعله أو ما الذي يُنتظر لاحقاً، متى ذكره المصدر)، مختلفة عن العنوان والمقتطف والمقدّمة. لا تُكرّر الجملة نفسها في أكثر من حقل، ولا تجعل الملخّص إعادة صياغة للمقتطف. وإذا كان مقتطف المسوّدة يعيد صياغة المقدّمة فأعد كتابته وفق هذا التعريف.

عقد المخرجات: أعد كائن JSON واحداً فقط، دون أي نصّ قبله أو بعده ودون أسيجة برمجية، بالحقول التالية حصراً ولا غير:
{"title":"…","excerpt":"…","summary":"…","body":"فقرات مفصولة بسطر فارغ","edit_applied":true,"editorial_verdict":"ready" أو "needs_human_review","issues_found":["…"],"changes_made":["…"]}
- لا حقول إضافية. جميع حقول المقال نصوص غير فارغة. issues_found وchanges_made مصفوفتا قيم قصيرة.
- أمانة changes_made: صِف فيها الفروق الفعلية فقط بين نسختك والمسوّدة الأصلية. إذا لم يتغيّر النص فاكتب ذلك صراحةً («لم يتغيّر النص»)، مع ذكر ما تغيّر فعلاً في العنوان أو المقتطف أو الملخّص إن وُجد. لا تدّعِ أبداً تعديلاً لم يحدث.`;
  if (opts.repairIssues && opts.repairIssues.length) {
    const list = opts.repairIssues
      .map((code) => `- ${repairIssueText(code)}`)
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
  // P2R-10: how many over-long list items were truncated (absent when none).
  list_items_truncated?: number;
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

// P2R-10: an over-long issues_found/changes_made item is TRUNCATED (with «…»),
// never grounds for a schema rejection — these are the model's self-report, not
// article content, and rejecting lost otherwise-valid edits. Item count, type
// and non-emptiness are still enforced. The truncation count is carried on the
// output and recorded in the audit reasons (editor_list_items_truncated:N).
function isControlList(v: unknown): v is string[] {
  return (
    Array.isArray(v) &&
    v.length <= ED_MAX_LIST_ITEMS &&
    v.every((x) => typeof x === "string" && x.trim().length > 0)
  );
}

function truncateControlList(xs: string[]): { items: string[]; truncated: number } {
  let truncated = 0;
  const items = xs.map((x) => {
    if (x.length <= ED_MAX_LIST_ITEM_CHARS) return x;
    truncated++;
    return x.slice(0, ED_MAX_LIST_ITEM_CHARS - 1).trimEnd() + "…";
  });
  return { items, truncated };
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
  const issuesT = truncateControlList(o.issues_found);
  const changesT = truncateControlList(o.changes_made);

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
      issues_found: issuesT.items,
      changes_made: changesT.items,
      ...(issuesT.truncated + changesT.truncated > 0
        ? { list_items_truncated: issuesT.truncated + changesT.truncated }
        : {}),
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
  // P4R-9: an excerpt restating the lead is a wording issue the one editorial
  // repair can fix (rewrite the excerpt as the stake, facts unchanged).
  "editorial_excerpt_duplicates_opening",
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
// Excerpt↔title and summary↔excerpt near-duplication (raw words). The
// excerpt↔lead test uses content words at 0.5 (P4R-9, excerptDuplicatesLead).
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
// P2-FIX4: "hydrochloride" is removed — a chemical descriptor is part of the
// exact identity the gloss contract requires (see the e2.0 note above), so it
// can never be "unnecessary". The remaining dosage-form words are scanned only
// OUTSIDE permitted first-mention gloss spans (stripGlossSpans).
const FORMAL_ENGLISH_PATTERNS = ["for injection", "injection"];
// The recall verb credited to a REGULATOR subject (wrong when a company
// initiated the recall). Matched as normalized substrings.
const REGULATOR_RECALL_PATTERNS = [
  "سحبت ادارة", "سحب ادارة", "تسحب ادارة", "سحبت هيئة", "سحبت الهيئة", "سحبت هيئه",
  "سحبت السلطات", "سحب السلطات", "سحبت وزارة", "سحبت الجهات الصحية",
];
// P2-FIX5: SOURCE phrasing that shows the REGULATOR itself initiated/ordered
// the recall. When the verified source carries it, crediting the regulator is
// correct, so the mis-attribution warning is suppressed. Normalized substrings.
// Matched on normalizePhrase output (alef folded, diacritics stripped); the
// regulator's full name may sit between "قررت الهيئة" and "سحب" within a clause.
const SOURCE_REGULATOR_INITIATED_PATTERNS = [
  /(?:^|[^\p{L}])[وف]?سحبت (?:ال)?هيئ[ةه](?![\p{L}])/u,
  /(?:^|[^\p{L}])[وف]?قررت (?:ال)?هيئ[ةه](?![\p{L}])[^.،؛!؟\n]{0,60}?[^\p{L}]ب?سحب/u,
  /(?:^|[^\p{L}])[وف]?امرت (?:ال)?هيئ[ةه](?![\p{L}])/u,
  // P2R-5: «أصدرت الهيئة/الإدارة/الوزارة … (قراراً/تعميماً) بسحب …» and
  // «قرار … بسحب» — the authority issued the recall order.
  /(?:^|[^\p{L}])[وف]?اصدرت (?:ال)?(?:هيئ[ةه]|ادار[ةه]|وزار[ةه]|سلطات|جهات)[^.،؛!؟\n]{0,80}?سحب/u,
  // P2R2-G: «قرار … بسحب» counts only with a REGULATOR subject next to
  // «قرار» («قرار الهيئة/الإدارة/الوكالة/الوزارة … بسحب»); «قرار الشركة بسحب»
  // is a company decision and never suppresses the flag.
  /(?:^|[^\p{L}])[وفب]?(?:ال)?قرار(?:ا|ات)?\s+(?:صادر\s+)?(?:عن\s+|من\s+)?(?:ال)?(?:هيئ[ةه]|ادار[ةه]|وكال[ةه]|وزار[ةه]|سلطات)(?![\p{L}])[^.،؛!؟\n]{0,60}?[^\p{L}]بسحب/u,
];
// P2-FIX5: a company-initiated recall needs a recall verb within this many
// words of a company reference (شركة / a corporate-suffix name / "company").
const COMPANY_RECALL_WINDOW_WORDS = 6;
// P2R-5: ORDER-aware company initiation. Arabic is verb–subject: an initiating
// verb (سحبت/تسحب/بدأت/أعلنت/قامت/قررت) followed within 2 words by «شركة»
// («سحبت شركة…»). English is subject–verb: a company word followed within 6
// words by a recall verb ("the company is recalling"). «مصنع الشركة وسحب …»
// (company noun BEFORE an Arabic recall noun) no longer counts.
const AR_COMPANY_TOKEN_RE = /^(?:[وفبل]|ال|وال|بال|لل)?شرك(?:ة|ه|ات)$/;
const AR_INITIATING_VERB_RE = /^[وف]?(?:سحبت|تسحب|بدات|اعلنت|قامت|قررت)$/;
const EN_COMPANY_TOKEN_RE = /^(?:company|manufacturer|inc|llc|ltd|corp|corporation|pharmaceuticals?|laboratories)$/;
const EN_RECALL_TOKEN_RE = /^(?:recall|recalls|recalled|recalling)$/;

/** Did the verified source show a COMPANY initiating the recall? Explicit
 *  voluntary wording, or the order-aware verb/company pattern above. Mere
 *  co-occurrence of "شركة" and "سحب" anywhere in the source does not count. */
function sourceShowsCompanyInitiated(srcNorm: string): boolean {
  if (/voluntar|طوع/.test(srcNorm)) return true;
  const toks = srcNorm.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (let i = 0; i < toks.length; i++) {
    if (AR_INITIATING_VERB_RE.test(toks[i])) {
      for (let k = i + 1; k <= Math.min(toks.length - 1, i + 2); k++) if (AR_COMPANY_TOKEN_RE.test(toks[k])) return true;
    }
    if (EN_COMPANY_TOKEN_RE.test(toks[i])) {
      for (let k = i + 1; k <= Math.min(toks.length - 1, i + COMPANY_RECALL_WINDOW_WORDS); k++) {
        if (EN_RECALL_TOKEN_RE.test(toks[k])) return true;
      }
    }
  }
  return false;
}

/** P2-FIX4: remove permitted first-mention gloss spans — a parenthetical that
 *  immediately follows Arabic text (optional whitespace only), the gloss
 *  contract shape «بابافيرين (Papaverine)». Parentheses that do not follow
 *  Arabic text (e.g. opening a line or following Latin) are kept. */
function stripGlossSpans(s: string): string {
  return (s ?? "").replace(/([؀-ۿ])(\s*)\([^()\n]*\)/g, "$1$2");
}
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
  opts: { verificationOnly?: string[]; sourceText?: string; essentialEntities?: string[] } = {},
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

  // Editorial Simplification V1: headline stronger than evidence usually
  // supports (replacement/finality cues). Advisory — the editor is told to
  // retitle; never blocks, never overrides factual checks.
  if (HEADLINE_OVERSTATEMENT_CUES.some((c) => (title ?? "").includes(c))) {
    advisory.add("editorial_headline_overstatement");
  }
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
    // P4R-9: content-word Jaccard vs the lead paragraph (salmaWriter
    // excerptDuplicatesLead, threshold EDITORIAL_EXCERPT_LEAD_JACCARD = 0.5).
    if (exNorm && excerptDuplicatesLead(excerpt, body)) {
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
    // Unnecessary formal English identity wording (for Injection / Injection),
    // scanned only OUTSIDE permitted first-mention gloss spans (P2-FIX4): the
    // exact identity inside «… (Papaverine Hydrochloride Injection, USP)» is the
    // gloss contract, not unnecessary English. The title is never stripped
    // (glosses are not allowed there).
    const formalScan = foldDigits(
      `${title}\n${stripGlossSpans(visible)}\n${stripGlossSpans(summary)}`,
    ).toLowerCase();
    if (FORMAL_ENGLISH_PATTERNS.some((p) => formalScan.includes(p))) {
      review.add("editorial_unnecessary_formal_english");
    }
    // Incorrect attribution: recall credited to the regulator when the verified
    // source shows a company initiated it. Requires the source to judge.
    // P2-FIX5: company initiation needs a recall verb near a company reference
    // (or voluntary wording), and the warning is suppressed when the source
    // itself says the regulator initiated/ordered the recall.
    if (opts.sourceText) {
      const srcNorm = normalizePhrase(opts.sourceText);
      const companyInitiated = sourceShowsCompanyInitiated(srcNorm);
      const sourceRegulatorInitiated = SOURCE_REGULATOR_INITIATED_PATTERNS.some((re) => re.test(srcNorm));
      const creditsRegulator = REGULATOR_RECALL_PATTERNS.some((p) => allNormRV.includes(p));
      if (companyInitiated && creditsRegulator && !sourceRegulatorInitiated) {
        review.add("editorial_incorrect_recall_attribution");
      }
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
    // P2-A2: recalled-unit scope word. The source scopes the recall to a
    // lot/batch (lot, batch, دفعة, تشغيلة) but the draft calls the unit
    // «عبوة/عبوات» — or the reverse (a package-scoped source rendered as a
    // دفعة/تشغيلة). A package and a production batch are different scopes, so
    // the reader could misjudge whether their product is affected. REVIEW.
    // P2R-8: compared on the RECALL-ADJACENT unit (the unit nearest the first
    // recall mention, within ~10 words) on both sides, so a source that names
    // the lot in its recall statement and "vials" elsewhere is still lot-scoped.
    if (opts.sourceText) {
      const srcUnit = recallAdjacentUnit(opts.sourceText);
      const draftUnit = recallAdjacentUnit(`${title}\n${excerpt}\n${summary}\n${body}`);
      if (srcUnit && draftUnit && srcUnit !== draftUnit) review.add("scope_word_mismatch");
    }
    // P2-A3: the source states an explicit recall severity classification
    // (Class I/II/III, الفئة الأولى/الثانية/الثالثة, "most serious") and the
    // final draft carries none of it in any wording. REVIEW.
    // P2R-9: safety_alert only; the class phrase must be recall-adjacent.
    if (opts.sourceText && profile === "safety_alert") {
      const cls = sourceSeverityClass(opts.sourceText);
      if (cls && !draftCarriesSeverity(`${title} ${excerpt} ${summary} ${body}`, cls)) {
        review.add("missing_severity_class");
      }
    }
    // Body longer than a fast reader needs (soft, advisory).
    const rvMax = EDITORIAL_READER_VALUE_MAX[profile];
    if (body && rvMax !== undefined && countWords(body) > rvMax) {
      advisory.add("editorial_body_exceeds_reader_value");
    }
  }

  // P2-A4: an Arabic rendering before a first-mention gloss that does not
  // plausibly spell the Latin identity (consonant-skeleton check). REVIEW only.
  for (const ent of opts.essentialEntities ?? []) {
    if (!/[A-Za-z]/.test(ent) || regulatorGroup(stripFormalSuffixes(ent))) continue;
    const st = foreignEssentialNameStatus({ title, visible, entity: ent });
    if (st.transliterationSuspect) {
      review.add("name_transliteration_suspect");
      break;
    }
  }
  // P2R-7a: every rendering + «(Latin)» gloss pair, not only packet entities.
  if (suspectGlossPairs(`${visible}\n${summary}`).length) review.add("name_transliteration_suspect");

  // NF3: a figure supported ONLY by an ambiguous reading of the source's
  // typography (a plain-space «19 161» merged, or "1.100" read against its
  // document's convention) is held for human review — never blocking.
  if (opts.sourceText) {
    for (const raw of ambiguousNumericFigures(`${title}\n${excerpt}\n${summary}\n${body}`, opts.sourceText)) {
      review.add(`ambiguous_numeric_format:${raw}`);
    }
  }

  // P4R-5: the body follows the source's order of fact anchors (Spearman ρ ≥
  // 0.8 over ≥5 matched numbers/Latin names/entities). Measurement only: it is
  // recorded in the ADVISORY tier (editorial_advisory in the audit) so it never
  // changes the verdict, never blocks and never triggers a repair. (On the
  // Phase-4 corpus it fires on roughly half of the drafts — as needs_review it
  // would flip those verdicts; promote it only deliberately.)
  if (opts.sourceText && body && sourceOrderCorrelation(body, opts.sourceText, { entities: opts.essentialEntities }).fires) {
    advisory.add("source_order_paraphrase");
  }

  return {
    blocking: [...blocking],
    needs_review: [...review],
    advisory: [...advisory],
  };
}

// --- P2-A2 / P2-A3 helpers ---------------------------------------------------

// Recalled-unit vocabulary (token-level, on normalizePhrase output).
const UNIT_BATCH_TOKEN_RE = /^(?:lots?|batch(?:es)?|[وبلف]?(?:ال)?(?:دفع(?:ة|ه|ات|تين|تان)|تشغيل(?:ة|ه|ات|تين|تان)))$/u;
const UNIT_PACKAGE_TOKEN_RE = /^(?:packages?|packs?|cartons?|bottles?|vials?|containers?|boxes|box|tubes?|jars?|pouches?|sachets?|[وبلف]?(?:ال)?(?:عبو(?:ة|ه|ات|تين|تان)|علب(?:ة|ه)?|قارور(?:ة|ه)|قوارير|زجاج(?:ة|ه|ات)))$/u;
const RECALL_ANCHOR_TOKEN_RE = /^(?:recall\p{L}*|[وفب]?(?:ال)?(?:سحب\p{L}*|تسحب|يسحب|مسحوب\p{L}*|استدعاء))$/u;
const RECALL_UNIT_WINDOW = 10;

/** The recalled unit nearest the FIRST recall mention (forward within ~10
 *  words, else backward): "batch" (lot/batch/دفعة/تشغيلة) or "package"
 *  (عبوة/bottle/vial/…), or null. A "lot number" label anchors a batch. The
 *  English quantity idioms "a lot of"/"lots of" are removed first. */
export function recallAdjacentUnit(text: string): "batch" | "package" | null {
  const t = normalizePhrase(text)
    .replace(/\b(?<!single |one |affected |recalled )a lot of\b/g, " ")
    .replace(/(?<!all )\blots of\b/g, " ");
  const toks = t.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const kind = (tok: string) =>
    UNIT_BATCH_TOKEN_RE.test(tok) ? "batch" : UNIT_PACKAGE_TOKEN_RE.test(tok) ? "package" : null;
  for (let i = 0; i < toks.length; i++) {
    if (toks[i] === "lot" && toks[i + 1] === "number") return "batch";
    if (!RECALL_ANCHOR_TOKEN_RE.test(toks[i])) continue;
    for (let k = i + 1; k <= Math.min(toks.length - 1, i + RECALL_UNIT_WINDOW); k++) {
      const u = kind(toks[k]);
      if (u) return u;
    }
    for (let k = i - 1; k >= Math.max(0, i - RECALL_UNIT_WINDOW); k--) {
      const u = kind(toks[k]);
      if (u) return u;
    }
  }
  return null;
}

/** Back-compat summary of the source's recalled-unit vocabulary. */
export function sourceUnitScope(sourceText: string): { batch: boolean; pkg: boolean } {
  const u = recallAdjacentUnit(sourceText);
  return { batch: u === "batch", pkg: u === "package" };
}

export type SeverityClass = 1 | 2 | 3 | "most_serious";

const ROMAN_CLASS: Record<string, 1 | 2 | 3> = { i: 1, ii: 2, iii: 3, "1": 1, "2": 2, "3": 3 };
const AR_ORDINAL_CLASS: [RegExp, 1 | 2 | 3][] = [
  [/الاول[ىي]/, 1], [/الثاني[ةه]/, 2], [/الثالث[ةه]/, 3],
];
// Seriousness wording that carries the classification without the number.
const SERIOUSNESS_PHRASES = [
  /most serious/, /الاكثر خطور[ةه]/, /الاشد خطور[ةه]/, /اعلى (?:درج(?:ة|ه|ات)|مستوى|مستويات) (?:من )?(?:ال)?خطور[ةه]/,
  /اخطر (?:انواع|فئات|درجات)/, /اخطر نوع/,
];

/** The explicit recall severity classification the source states, or null.
 *  "Class X" counts only next to a recall word (a Class II DEVICE
 *  classification is not a recall severity). */
export function sourceSeverityClass(sourceText: string): SeverityClass | null {
  const t = normalizePhrase(sourceText);
  const en = t.match(/\bclass\s+(iii|ii|i|[123])\b(?=[^.]{0,40}\brecall)|\brecall[^.]{0,40}\bclass\s+(iii|ii|i|[123])\b/);
  if (en) return ROMAN_CLASS[en[1] ?? en[2]];
  // P2R-9: the Arabic class phrase / seriousness phrase must be RECALL-
  // ADJACENT (a recall word in the same sentence, within ~40 chars), so «حروق من الدرجة الثانية»
  // ("second-degree burns") elsewhere in a recall notice is not a recall class.
  const near = (idx: number, len: number) => {
    // Same sentence only, and within ~40 chars of the phrase.
    const before = t.slice(Math.max(0, idx - 40), idx).split(/[.!?؟\n]/).pop() ?? "";
    const after = t.slice(idx + len, idx + len + 40).split(/[.!?؟\n]/)[0] ?? "";
    return /سحب|استدعاء|recall/.test(`${before} ${after}`);
  };
  for (const ar of t.matchAll(/(?:الفئ[ةه]|الدرج[ةه]|فئ[ةه]|درج[ةه])\s+(الاول[ىي]|الثاني[ةه]|الثالث[ةه])/g)) {
    if (!near(ar.index ?? 0, ar[0].length)) continue;
    for (const [re, n] of AR_ORDINAL_CLASS) if (re.test(ar[1])) return n;
  }
  for (const re of SERIOUSNESS_PHRASES) {
    const m = new RegExp(re.source, "g").exec(t);
    if (m && near(m.index, m[0].length)) return "most_serious";
  }
  return null;
}

/** Does the draft carry the source's severity classification in any wording —
 *  the same class number (Arabic ordinal, digit or Roman numeral next to
 *  فئة/درجة/class), or, for a Class I / "most serious" recall, a seriousness
 *  phrase such as «الفئة الأكثر خطورة»? */
export function draftCarriesSeverity(draftText: string, cls: SeverityClass): boolean {
  const t = normalizePhrase(draftText);
  const serious = SERIOUSNESS_PHRASES.some((re) => re.test(t));
  if (cls === "most_serious") return serious || /(?:فئ[ةه]|درج[ةه]|class)\s+(?:ال)?(?:اول[ىي]|1|i)(?![\p{L}\d])/u.test(t);
  if (cls === 1 && serious) return true;
  const ordinal = cls === 1 ? "اول[ىي]" : cls === 2 ? "ثاني[ةه]" : "ثالث[ةه]";
  const roman = cls === 1 ? "i" : cls === 2 ? "ii" : "iii";
  const re = new RegExp(
    `(?:فئ[ةه]|درج[ةه]|class)\\s*\\(?\\s*(?:ال)?(?:${ordinal}|${cls}|${roman})(?![\\p{L}\\d])`,
    "u",
  );
  return re.test(t);
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
// P2-B6: `errors` carries the FULL list of blocking codes behind a failure
// (reason joins them with "|"), so the audit never hides a code behind errors[0].
export type EditorRevalidate = (
  article: EditorArticle,
) =>
  | { ok: true; readMinutes: number; cleanTitle: string }
  | { ok: false; reason: string; errors?: string[] };

/**
 * P2-B6: judge an edit against the WRITER draft's own errors. The edit fails
 * re-validation ONLY on errors the writer draft did not already carry; an
 * inherited error does not discard an otherwise-sound edit (the post-editor
 * fidelity stage still validates the chosen draft in full and repairs/rejects
 * it — nothing is waived). The failure reason lists EVERY new code.
 */
export function revalidateAgainstBaseline(
  v: { errors: string[]; readMinutes: number; cleanTitle: string },
  baselineErrors: readonly string[],
): ReturnType<EditorRevalidate> {
  const base = new Set(baselineErrors);
  const fresh = [...new Set(v.errors.filter((e) => !base.has(e)))];
  if (fresh.length === 0) return { ok: true, readMinutes: v.readMinutes, cleanTitle: v.cleanTitle };
  return { ok: false, reason: fresh.join("|"), errors: fresh };
}

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
  // P2-C9 traceability (owner condition 5). `decision` is the single editor
  // outcome: "accepted" (an edit kept as-is, possibly after a non-improving
  // repair), "repaired" (a repaired edit kept), "kept_original" (no edit could
  // be evaluated — transport/formatting failure), "factual_rejected" (the edit
  // breached a factual / protected-fact check and was discarded). `reasons` is
  // the FULL code list behind the decision (never just the first code);
  // `repair_attempted` is true whenever a second (repair) call was spent on a
  // repair; `repair_restored` lists the dropped items a restore repair put back.
  decision: EditorDecision;
  reasons: string[];
  repair_attempted: boolean;
  repair_restored: string[];
  // P4R2: semantic fidelity checker outcome (semanticCheck.ts). Present only
  // when SEMANTIC_CHECK_ENABLED is on; absent (undefined) otherwise.
  semantic_check?: SemanticCheckAudit;
};

/** P4R2: compact semantic-check audit. Quotes the mismatching pairs so an
 *  editor sees exactly which sentence changed meaning on which dimension. */
export type SemanticCheckAudit = {
  status: "passed" | "mismatch" | "checker_failed";
  model: string | null;
  pairs_checked: number;
  pairs_truncated: number;
  unaligned: number;
  failure_reason: string | null;
  editor_reverted: boolean;
  review_required: boolean;
  blocking: string[];
  findings: {
    pair_id: string;
    kind: "editor_changed" | "editor_added" | "writer_risk";
    field: string;
    codes: string[];
    candidate: string;
    reference: string[];
  }[];
};

export type EditorDecision = "accepted" | "repaired" | "kept_original" | "factual_rejected";

/** P2-D10: the editor-outcome audit columns written to ingestion_decisions
 *  (editor_outcome / editor_prompt_version). Null when no editor ran. */
export function editorDecisionAuditFields(
  audit: Pick<EditorialAudit, "decision"> | null | undefined,
): { editor_outcome: EditorDecision | null; editor_prompt_version: string | null } {
  if (!audit) return { editor_outcome: null, editor_prompt_version: null };
  return { editor_outcome: audit.decision, editor_prompt_version: EDITOR_PROMPT_VERSION };
}

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

/**
 * P2-B8: is a reader-essential entity present in an article (title + excerpt +
 * body)? Compared on the ESSENTIAL identity (formal suffixes removed) with the
 * same Arabic-aware rules as the writer check (salmaWriter.checkFactGrounding):
 *   - a country: the term or its canonical Arabic name, folded-token match;
 *   - a regulator (FDA/WHO/EMA/SFDA/CDC): any member of its fixed group;
 *   - a foreign (Latin) name: the exact identity, verbatim or inside an
 *     Arabic-rendering + gloss (foreignEssentialNameStatus) — never a fuzzy
 *     transliteration;
 *   - a native Arabic name: folded token-run match (أ/ا, ة/ه, ال…).
 */
export function essentialEntityPresent(ent: string, a: EditorArticle): boolean {
  // P2R2-F: a "X dba Y" pair is present when EITHER name is.
  const aliases = dbaAliases(ent);
  if (aliases) return aliases.some((x) => essentialEntityPresent(x, a));
  const identity = stripFormalSuffixes(ent);
  const e = normalizeForCompare(identity);
  if (!e) return true;
  const text = `${a.title}\n${a.excerpt ?? ""}\n${a.body}`;
  const countryEqs = arabicCountryEquivalents(e);
  if (countryEqs.length) {
    return arabicEntityPresent(identity, text) || countryEqs.some((eq) => arabicEntityPresent(eq, text));
  }
  const reg = regulatorGroup(identity);
  if (reg) return regulatorPresent(reg, text);
  if (/[a-z]/.test(e)) {
    if (normalizeForCompare(text).includes(e)) return true;
    return foreignEssentialNameStatus({ title: a.title, visible: `${a.excerpt ?? ""}\n${a.body}`, entity: ent }).present;
  }
  return arabicEntityPresent(identity, text);
}

/** Reader-essential entities the original surfaced but the edited draft dropped. */
export function droppedEssentialEntities(
  original: EditorArticle,
  edited: EditorArticle,
  packet: EditorFactPacket,
): string[] {
  const dropped: string[] = [];
  for (const ent of packet.readerEssential) {
    // An editor that correctly drops "for Injection, USP" while keeping the core
    // name, or that renders "Kuwait"/"FDA" by its canonical Arabic name, has
    // NOT dropped the entity (see essentialEntityPresent).
    if (essentialEntityPresent(ent, original) && !essentialEntityPresent(ent, edited)) dropped.push(ent);
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

  // P2-C9: a kept original is "factual_rejected" when the edit itself breached
  // a factual / protected-fact check, else "kept_original" (the edit could not
  // be evaluated: transport or formatting failure).
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
      decision: extra.decision ?? "kept_original",
      reasons: extra.reasons ?? [reason],
      repair_attempted: extra.repair_attempted ?? false,
      repair_restored: extra.repair_restored ?? [],
    },
  });

  // A single evaluated attempt (one model call + full evaluation), reused for the
  // first pass, the one formatting recovery, and the one repair. It only
  // classifies its own outcome:
  //   - "valid"            → parsed + factually valid + protected facts preserved.
  //                          A RETAINABLE edit; its gate may still carry warnings.
  //   - "dropped"          → parsed + factually valid, but dropped a required
  //                          action and/or a reader-essential entity (and NOT all
  //                          risk). P2-B7: eligible for ONE targeted restore repair.
  //   - "factual_rejected" → failed factual re-validation (new errors only,
  //                          P2-B6), dropped ALL risk (never repaired), or a
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
      list_items_truncated: number;
    };
  };
  type DroppedOutcome = {
    kind: "dropped";
    reason: string;
    reasons: string[];
    article: EditorArticle;
    actions: string[];
    entities: string[];
    extra: Partial<EditorialAudit>;
  };
  type AttemptOutcome =
    | ValidOutcome
    | DroppedOutcome
    | { kind: "factual_rejected"; reason: string; reasons: string[]; factual: boolean; extra: Partial<EditorialAudit> }
    | { kind: "format_failed"; reason: string; reasons: string[]; extra: Partial<EditorialAudit> };

  // The second call is EITHER a formatting recovery OR a repair (an editorial
  // repair or a P2-B7 restore repair) — never both.
  type AttemptMode =
    | { type: "normal" }
    | { type: "formatting_recovery" }
    | { type: "editorial_repair"; draft: EditorArticle; issues: string[] };

  const attempt = async (mode: AttemptMode): Promise<AttemptOutcome> => {
    // 1) Editor call. A transport failure is non-recoverable; a completion-state
    //    failure is a formatting failure.
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
        ? { kind: "format_failed", reason, reasons: [reason], extra }
        : { kind: "factual_rejected", reason, reasons: [reason], factual: false, extra };
    }

    // 2) Strict parse — every parser failure is a structural/formatting failure.
    const parsed = parseEditorOutput(res.content);
    if (!parsed.ok) {
      return {
        kind: "format_failed",
        reason: parsed.error,
        reasons: [parsed.error],
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
      list_items_truncated: out.list_items_truncated ?? 0,
    };
    const auditCommon: Partial<EditorialAudit> = {
      editor_model_used: model,
      editor_output_parsed: true,
      model_editorial_verdict: out.editorial_verdict,
      issues_found: out.issues_found,
      changes_made: out.changes_made,
    };

    // 3) Factual re-validation of the edited version (never retried on failure).
    //    P2-B6: the injected revalidate fails only on errors NEW relative to the
    //    writer draft and reports every new code.
    const rev = revalidate(editedArticle);
    if (!rev.ok) {
      const revErrors = rev.errors && rev.errors.length ? rev.errors : [rev.reason];
      const extra: Partial<EditorialAudit> = { ...auditCommon, factual_revalidation_result: "failed" };
      // P2-B7: when the ONLY new errors are omissions of items the edit dropped
      // (a safety alert's missing_essential_entity / missing_official_action —
      // the validator's view of the same drop the guards below catch), the edit
      // is routed to the single targeted restore repair instead of a direct
      // discard. The repair must then pass the FULL re-validation; nothing here
      // accepts an edit with the item still missing.
      const restorable = revErrors.every(
        (e) => e.startsWith("missing_essential_entity:") || e === "missing_official_action",
      );
      if (restorable && !droppedAllRisk(original.article, editedArticle, packet)) {
        const actions = droppedRequiredActions(original.article, editedArticle, packet);
        const entities = [
          ...new Set([
            ...revErrors.filter((e) => e.startsWith("missing_essential_entity:")).map((e) => e.slice("missing_essential_entity:".length)),
            ...droppedEssentialEntities(original.article, editedArticle, packet),
          ]),
        ];
        const actionsNamed = !revErrors.includes("missing_official_action") || actions.length > 0;
        if (actionsNamed && actions.length + entities.length > 0) {
          return {
            kind: "dropped",
            reason: rev.reason,
            reasons: [
              ...revErrors,
              ...actions.map((a) => `editor_dropped_required_action:${a}`),
              ...entities.map((e) => `editor_dropped_essential_entity:${e}`),
            ],
            article: editedArticle,
            actions,
            entities,
            extra,
          };
        }
      }
      return { kind: "factual_rejected", reason: rev.reason, reasons: revErrors, factual: true, extra };
    }
    // Store the brand-stripped clean title (as the writer path does), then run
    // all remaining protected-fact and editorial-gate checks over that form.
    const finalArticle: EditorArticle = { ...editedArticle, title: rev.cleanTitle || editedArticle.title };

    // 4) Protected-fact preservation: required actions, essential entities, risk.
    //    The FULL list of dropped items is collected (P2-C9). Dropping ALL risk
    //    is an unconditional discard (no repair); a dropped action/entity is
    //    eligible for one targeted restore repair (P2-B7).
    const droppedActions = droppedRequiredActions(original.article, finalArticle, packet);
    const droppedEntities = droppedEssentialEntities(original.article, finalArticle, packet);
    const riskDropped = droppedAllRisk(original.article, finalArticle, packet);
    const dropReasons = [
      ...droppedActions.map((a) => `editor_dropped_required_action:${a}`),
      ...droppedEntities.map((e) => `editor_dropped_essential_entity:${e}`),
      ...(riskDropped ? ["editor_dropped_risk"] : []),
    ];
    if (dropReasons.length) {
      const extra: Partial<EditorialAudit> = { ...auditCommon, factual_revalidation_result: "passed" };
      if (riskDropped) {
        return { kind: "factual_rejected", reason: dropReasons[0], reasons: dropReasons, factual: true, extra };
      }
      return {
        kind: "dropped",
        reason: dropReasons[0],
        reasons: dropReasons,
        article: finalArticle,
        actions: droppedActions,
        entities: droppedEntities,
        extra,
      };
    }

    // 5) Deterministic editorial gate. A factually-valid edit is ALWAYS retainable
    //    (E1.8): the gate only shapes the verdict and, when it raises repairable
    //    warnings, triggers the one editorial-repair call.
    const gate = editorialGate(finalArticle, profile, {
      verificationOnly: args.verificationOnly,
      sourceText: packet.sourceText,
      essentialEntities: packet.readerEssential,
    });
    // P2-A5: the editor changed the Arabic rendering in front of a gloss for
    // the same identity (e.g. «سكيترا (Spectra)» → «سبكترا (Spectra)»). The
    // editor may fix a transliteration only by restoring the original Latin
    // name, so any rendering change is held for human review.
    if (renderingChanged(original.article, finalArticle, packet.readerEssential)) {
      gate.needs_review.push("name_rendering_changed");
    }
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
      reasons?: string[];
      repair_restored?: string[];
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
        decision: overlay.final_draft_source === "repaired_edit" ? "repaired" : "accepted",
        reasons: [
          ...(overlay.reasons ?? []),
          ...(chosen.common.list_items_truncated
            ? [`editor_list_items_truncated:${chosen.common.list_items_truncated}`]
            : []),
        ],
        repair_attempted: overlay.second_attempt_type === "editorial_repair",
        repair_restored: overlay.repair_restored ?? [],
      },
    };
  };

  // ---- First attempt --------------------------------------------------------
  const first = await attempt({ type: "normal" });

  // Formatting-only failure ⇒ exactly ONE formatting recovery (no repair
  // afterwards; the two-call budget is spent).
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
        reasons: [first.reason],
      });
    }
    // Recovery failed too — no factually-valid editor draft exists, keep
    // original. A recovered draft that dropped an item cannot be restored: the
    // two-call budget is spent (recorded in reasons).
    const factual = recovered.kind === "dropped" || (recovered.kind === "factual_rejected" && recovered.factual);
    return keepOriginal(recovered.reason, {
      ...recovered.extra,
      editor_attempts: 2,
      first_attempt_failure_reason: first.reason,
      recovery_attempted: true,
      recovery_succeeded: false,
      second_attempt_type: "formatting_recovery",
      final_editor_failure_reason: recovered.reason,
      final_rejection_reason: recovered.reason,
      decision: factual ? "factual_rejected" : "kept_original",
      reasons: [
        first.reason,
        ...recovered.reasons,
        ...(recovered.kind === "dropped" ? ["restore_repair_not_attempted:call_budget_spent"] : []),
      ],
    });
  }

  // Parsed but failed a factual check (or dropped all risk), or a
  // non-recoverable transport failure — never retried.
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
      decision: first.factual ? "factual_rejected" : "kept_original",
      reasons: first.reasons,
    });
  }

  // ---- P2-B7: a dropped required action / essential entity ⇒ ONE targeted
  // restore repair over the FIRST edited draft (the existing single-repair
  // path), naming each exact missing item. The repair is accepted only when it
  // is fully "valid": every item is back, re-validation (new errors only)
  // passes, and no other action/entity/risk was dropped. Otherwise the original
  // writer draft is kept exactly as before.
  if (first.kind === "dropped") {
    const restoreIssues = [
      ...first.actions.map((a) => `${RESTORE_ACTION_PREFIX}${a}`),
      ...first.entities.map((e) => `${RESTORE_ENTITY_PREFIX}${e}`),
    ];
    const items = [...first.actions, ...first.entities];
    const restored = await attempt({ type: "editorial_repair", draft: first.article, issues: restoreIssues });
    if (restored.kind === "valid") {
      // Belt-and-braces: every named item must now be present.
      const stillMissing = [
        ...droppedRequiredActions(original.article, restored.article, packet),
        ...droppedEssentialEntities(original.article, restored.article, packet),
      ];
      if (stillMissing.length === 0) {
        return buildAccepted(restored, {
          final_draft_source: "repaired_edit",
          second_attempt_type: "editorial_repair",
          editor_attempts: 2,
          first_attempt_failure_reason: first.reason,
          recovery_attempted: false,
          recovery_succeeded: false,
          repair_issues: restoreIssues,
          repair_succeeded: true,
          final_rejection_reason: null,
          reasons: first.reasons,
          repair_restored: items,
        });
      }
    }
    const repairFailure =
      restored.kind === "valid" ? "restore_repair_failed:items_still_missing" : `restore_repair_failed:${restored.reason}`;
    return keepOriginal(first.reason, {
      ...first.extra,
      editor_attempts: 2,
      first_attempt_failure_reason: first.reason,
      recovery_attempted: false,
      recovery_succeeded: false,
      second_attempt_type: "editorial_repair",
      repair_issues: restoreIssues,
      repair_succeeded: false,
      final_editor_failure_reason: first.reason,
      final_rejection_reason: first.reason,
      decision: "factual_rejected",
      reasons: [...first.reasons, repairFailure, ...(restored.kind === "valid" ? [] : restored.reasons)],
      repair_attempted: true,
      repair_restored: [],
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
        reasons: firstIssues,
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
      reasons: [...firstIssues, "editorial_repair_not_improved"],
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
    reasons: [...firstIssues, ...repair.reasons],
  });
}

/** P2-A5: did the edit change the Arabic rendering in front of a first-mention
 *  gloss for any foreign reader-essential identity? Compared on folded tokens;
 *  only when BOTH drafts gloss the identity (restoring the Latin name — no
 *  rendering left — is the permitted fix and is not flagged). */
export function renderingChanged(
  original: EditorArticle,
  edited: EditorArticle,
  essentialEntities: string[],
): boolean {
  for (const ent of essentialEntities) {
    if (!/[A-Za-z]/.test(ent)) continue;
    const o = glossedRendering(`${original.excerpt ?? ""}\n${original.body}`, ent);
    const e = glossedRendering(`${edited.excerpt ?? ""}\n${edited.body}`, ent);
    if (!o || !e) continue;
    if (arabicMatchTokens(o.rendering).join(" ") !== arabicMatchTokens(e.rendering).join(" ")) return true;
  }
  return false;
}
