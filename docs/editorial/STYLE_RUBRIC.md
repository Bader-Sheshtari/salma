# Salma Style Rubric — e2.0 unified editorial standard

Status: Phase 1 (prompts). Encoded in `WRITER_PROMPT_VERSION = "e2.0-salma-writer"` and
`EDITOR_PROMPT_VERSION = "e2.0-salma-editor"`; the develop-story overlay follows the same
standard. This rubric is the seed for the Phase 4 human review checklist.

Accuracy and trust outrank style. Every item below is applied **without** changing,
dropping or inventing any fact.

## The eight principles

1. **Lead with the news.** The first sentence carries the main news or takeaway (what
   happened / what was found, plus why it matters when that comes naturally). No
   background, preamble or "announced/revealed" press-release openings unless the
   announcing body *is* the news. No fixed paragraph formula.
2. **Simple, natural, elegant MSA.** Modern Standard journalistic Arabic for a smart
   non-specialist in Kuwait/GCC; no dialect, no official/ceremonial/promotional register,
   no transliteration where an Arabic word exists.
3. **No filler.** No unnecessary introductions, repeated explanations, excessive
   technical detail, or artificial conclusions.
4. **Extract, don't paraphrase.** Decide what the reader needs and write that; do not
   re-word the source sentence by sentence or copy its register.
5. **Length follows significance.** No numeric word targets. A routine item is a few
   short paragraphs; a major or complex story is as long as its substance requires, never
   longer. (The code keeps wide *monitoring* bands — warnings only — see below.)
6. **Full factual and medical accuracy.** Numbers, dates, study sizes, names and official
   actions exactly as in the source. Keep every caveat that changes what the reader should
   conclude or do. Always state whether evidence is lab (مختبرية), animal (على الحيوانات)
   or human (على البشر).
7. **No sensationalism or overreach.** No unsupported claims, no invented context, no
   association-as-causation, and never generalize a specific finding (one group, dose,
   disease stage or marker) into a broader medical claim. Hedged verbs match the evidence
   (تشير، قد يساعد، ارتبط بـ).
8. **Every sentence earns its place.** If a sentence does not tell the reader something
   they need to understand or act on the news, cut it.

## Per-article checklist

| # | Check | Pass when |
|---|-------|-----------|
| 1 | Lead | Sentence 1 states the news/takeaway; no preamble; does not repeat the title. |
| 2 | Language | Natural MSA; short sentences, one idea each; paragraphs of 2–4 sentences. |
| 3 | No boilerplate | None of: «من المهم الإشارة إلى»، «تجدر الإشارة»، «في هذا السياق»، «من جهة أخرى»، repeated «ليس فقط… بل…»؛ none of the banned promo phrases (`BANNED_PROMO_PHRASES`, e.g. «ثورة طبية»، «اكتشاف مذهل»). |
| 4 | Ending | Ends when the information ends. «ما ننتظره الآن» only if the source names something concrete that is pending. No summary-of-the-above closing. |
| 5 | Terms | Explain first, name second. Secondary scientific terms (a protein, gene, pathway) the reader does not need are explained, not named. Foreign terms kept to a minimum. |
| 6 | Foreign names | Essential drug/company/product/agency names: Arabic first, then the exact original from the source in parentheses once at first mention, then Arabic only. Chemical descriptors (e.g. Hydrochloride) stay; pure regulatory labels (USP/NDC/Lot/Inc/LLC) may go. Title and excerpt Arabic-only. |
| 7 | Length | Proportionate to significance; no padding to "fill" a story, no thin treatment of a major one. |
| 8 | Evidence level | Lab / animal / human stated explicitly; animal or lab results never written as proven in people. |
| 9 | Scope | Findings stay limited to the population, dose, stage or marker studied; indicator ≠ outcome (e.g. lower cholesterol ≠ proven fewer strokes). |
| 10 | Fidelity | Every number, date, study size, name and official action matches the source; no invented quote, context or claim; regulator approvals by different bodies are not merged. |
| 11 | Safety alerts | Keeps what happened, the affected product/audience, the main confirmed risk, the required action, and whether injuries were reported (when the source says). |
| 12 | Fields | Title, excerpt, summary and lead do not duplicate one another; the summary adds something the excerpt does not. |
| 13 | Every sentence | Each sentence passes the "does the reader need this?" test. |

## Benchmark examples (tone and structure reference only — not verified facts)

**دراسة: ضعف تخلّص الدماغ من البروتينات الضارة قد يساهم في ألزهايمر**

تشير مراجعة علمية جديدة إلى أن تراكم البروتينات المرتبطة بمرض ألزهايمر قد لا يكون بسبب
زيادة إنتاجها فقط، بل أيضاً بسبب ضعف قدرة الدماغ على التخلص منها. وتركز المراجعة على بروتين
يساعد الدماغ على التخلص من هذه المواد، لكن نشاطه قد يتراجع مع التقدم في العمر ولدى بعض مرضى
ألزهايمر. وأظهرت تجارب على الفئران أن الحفاظ على وظيفة هذا البروتين قد يساعد في تقليل تراكم
المواد الضارة، لكن هذه النتائج لم تثبت فعاليتها لدى البشر بعد.

**جزيئات جديدة قد تساعد في السيطرة على الالتهابات**

اكتشف باحثون جزيئات جديدة قد تساعد مستقبلاً في تطوير علاجات للأمراض المرتبطة باضطرابات
الالتهاب. وتعمل هذه الجزيئات، التي أُطلق عليها اسم «BLUEs»، على تعطيل نشاط مجموعة من
البروتينات التي تساعد في تنظيم استجابة الجسم للالتهابات. وأظهرت التجارب المختبرية أن الجزيئات
نجحت في تقليل بعض الإشارات المرتبطة بالاستجابة المناعية، لكن فعاليتها في علاج الأمراض لدى
البشر لم تُختبر بعد.

What they demonstrate: the finding leads; three short paragraphs for a routine research
item; explain-not-name (benchmark 1 never names the protein); at most one foreign term
(«BLUEs»); explicit animal/lab vs human distinction; hedged verbs (قد تساعد، تشير); no
closing boilerplate.

## Monitoring bands (code, warning-only)

`PROFILE_WORD_BANDS` in `supabase/functions/ingest-news/salmaWriter.ts` — read by both the
writer validator (`word_count_outside_band`) and the editor gate
(`editorial_body_over_length`):

- standard_news / regulation_or_service / safety_alert: 60–500 words
- research_study: 60–600 words
- quick_news: retired from selection; a stored value uses the standard_news band and prompt.

These bands flag outliers for review; they are not writing targets and never block.

## Known Phase 2 items (guards/validators — unchanged in Phase 1)

- Editor gate `FORMAL_ENGLISH_PATTERNS` flags "hydrochloride" as unnecessary while
  `stripFormalSuffixes` treats it as identity; reconcile, then decide suffix policy.
- Editor parser requires a non-empty `summary`; making it truly optional needs a parser
  and schema change.
- `EDITORIAL_READER_VALUE_MAX` (140 words, quick_news/safety_alert advisory) predates
  significance-based length.
- Fidelity re-validation of Arabic-first edits vs essential-entity checks.
