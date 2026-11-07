// Jamal (جمال) integration — step 1–3 unit/integration tests (Rev 2).
// Everything here runs with MOCKED transports and synthetic fixtures: no
// network, no database, no production data (owner condition 8). The 5A
// technical-acceptance checklist maps onto these tests plus jamalWiring.test.ts.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  APPROVED_REFERENCES,
  J0_STUB,
  JAMAL_SANITIZER_VERSION,
  type JamalChat,
  type JamalConfig,
  resolveJamalConfig,
  runJamal,
  sanitizeJamalInput,
  writeJamalArticle,
} from "./jamal.ts";
import type { SourceText } from "./fetchSourceText.ts";

// ---- Fixtures (synthetic; no production data) -------------------------------

// A decoy fact that lives ONLY in the source page's related-links footer — the
// جاسكايد leak class. Jamal must never see it; the validator must still see it.
const FOOTER_DECOY = "اعتمدت الهيئة تسجيل مستحضر فيكتو لعلاج الصداع النصفي";

const FIXTURE_BODY = [
  "أعلنت هيئة الدواء الوطنية اعتماد مستحضر مرحبا لعلاج ارتفاع ضغط الدم لدى البالغين.",
  "وشملت الدراسة 1200 مشارك على مدى 24 شهراً، وأظهرت انخفاضاً بنسبة 15% في المضاعفات.",
  "وأكدت الهيئة أن الاعتماد لا يعني إتاحة المستحضر في الصيدليات قبل استكمال إجراءات التسجيل.",
  "",
  "محتوى ذو علاقة",
  FOOTER_DECOY,
].join("\n");

function mkVerified(overrides: Partial<SourceText> = {}): SourceText {
  const text = overrides.text ?? FIXTURE_BODY;
  return {
    ok: true,
    title: "هيئة الدواء تعتمد مستحضر مرحبا لعلاج ضغط الدم",
    text,
    method: "paragraphs",
    publishedDate: null,
    charCount: text.length,
    wordCount: text.split(/\s+/).length,
    finalUrl: "https://example.test/news/1",
    mustPreserve: [],
    ...overrides,
  } as SourceText;
}

const BASE_INPUT = {
  discovery: { originalTitle: "Drug approved", body: "", excerpt: "" },
  sourceName: "هيئة الدواء",
  registeredDomain: "example.test",
  sourceUrl: "https://example.test/news/1",
};

/** A grounded draft: every figure/claim exists in the fixture source. */
const GROUNDED_ARTICLE = {
  title: "هيئة الدواء تعتمد مستحضر مرحبا لعلاج ضغط الدم",
  excerpt: "الاعتماد يخص البالغين ولا يعني الإتاحة في الصيدليات قبل التسجيل.",
  body: "أعلنت هيئة الدواء الوطنية اعتماد مستحضر مرحبا لعلاج ارتفاع ضغط الدم لدى البالغين.\n\nوشملت الدراسة 1200 مشارك وأظهرت انخفاضاً بنسبة 15% في المضاعفات.\n\nوالاعتماد لا يعني إتاحة المستحضر في الصيدليات قبل استكمال إجراءات التسجيل.",
  source_reference: "هيئة الدواء",
  review_notes: ["اخترت إبراز شرط التسجيل"],
};

function mockChat(reply: unknown): JamalChat & { calls: { messages: { role: string; content: string }[]; responseFormat: unknown }[] } {
  const calls: { messages: { role: string; content: string }[]; responseFormat: unknown }[] = [];
  const fn = (async (messages: { role: string; content: string }[], responseFormat: unknown) => {
    calls.push({ messages, responseFormat });
    if (reply instanceof Error) return { ok: false as const, reason: "network_error" };
    return { ok: true as const, content: JSON.stringify(reply) };
  }) as JamalChat & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

// ---- Config / approved-reference registry -----------------------------------

test("registry: the approved reference set is EXACTLY the two owner-approved benchmarks", () => {
  assert.deepEqual(
    Object.keys(APPROVED_REFERENCES).sort(),
    ["benchmark-1-alzheimers", "benchmark-2-blues-inflammation"],
  );
});

test("config: a non-approved reference key is refused (rejected experiment outputs can never be referenced)", () => {
  const bad: JamalConfig = {
    ...J0_STUB,
    referenceExamples: ["voice-experiment-v2-article-1"],
  };
  assert.throws(() => resolveJamalConfig(bad), /jamal_reference_not_approved/);
});

test("atlas registry: exactly the owner-approved v1.2 atlas, byte-identical to the docs file", async () => {
  const { APPROVED_ATLASES } = await import("./jamal.ts");
  const { JAMAL_ATLAS_NAME, JAMAL_ATLAS_V1_2 } = await import("./jamalAtlas.ts");
  assert.deepEqual(Object.keys(APPROVED_ATLASES), ["salma_editorial_atlas_26_v1_2"]);
  assert.equal(JAMAL_ATLAS_NAME, "salma_editorial_atlas_26_v1_2");
  assert.equal(APPROVED_ATLASES[JAMAL_ATLAS_NAME], JAMAL_ATLAS_V1_2);
  // The TS constant is carried VERBATIM from the canonical docs file.
  const docsCopy = readFileSync(
    fileURLToPath(new URL("../../../docs/editorial/salma_editorial_atlas_26_v1_2.md", import.meta.url)),
    "utf8",
  );
  assert.equal(JAMAL_ATLAS_V1_2, docsCopy);
  // Load-bearing safety framing is present in the atlas itself.
  assert.ok(JAMAL_ATLAS_V1_2.includes("الحالات 01–25 افتراضية بالكامل"));
  assert.ok(JAMAL_ATLAS_V1_2.includes("الحقائق الموثقة وقواعد السلامة"));
});

test("config: a non-approved atlas key is refused", () => {
  const bad: JamalConfig = { ...J0_STUB, styleAtlas: "some-other-atlas" };
  assert.throws(() => resolveJamalConfig(bad), /jamal_atlas_not_approved:some-other-atlas/);
  // Absent atlas stays valid (stub and legacy configs are untouched).
  assert.equal(resolveJamalConfig(J0_STUB), J0_STUB);
});

test("config: select_then_write requires selection instructions; stub is clearly a stub", () => {
  assert.throws(
    () => resolveJamalConfig({ ...J0_STUB, technique: "select_then_write" }),
    /jamal_selection_instructions_required/,
  );
  assert.ok(J0_STUB.version.endsWith("-stub"));
  assert.equal(J0_STUB.referenceExamples.length, 0);
});

test("j1.0: the owner-approved identity resolves, cites exactly the two approved references, and is clearly versioned", async () => {
  const { J1_0, JAMAL_ACTIVE_CONFIG } = await import("./jamal.ts");
  assert.equal(J1_0.version, "j1.0-c1");
  assert.equal(J1_0.technique, "single_pass");
  assert.deepEqual(
    [...J1_0.referenceExamples].sort(),
    ["benchmark-1-alzheimers", "benchmark-2-blues-inflammation"],
  );
  assert.equal(resolveJamalConfig(J1_0), J1_0);
  assert.equal(JAMAL_ACTIVE_CONFIG, J1_0);
  // Atlas v1.2 is attached as a style reference (owner, 2026-11-07); the
  // identity text itself does NOT embed the atlas (registry supplies it).
  assert.equal(J1_0.styleAtlas, "salma_editorial_atlas_26_v1_2");
  assert.ok(!J1_0.instructions.write.includes("أطلس الأسلوب التحريري"));
  // Identity landmarks carried verbatim; envelope clearly marked as transport-only.
  const w = J1_0.instructions.write;
  assert.ok(w.includes("JAMAL — Editorial Identity j1.0"));
  assert.ok(w.includes("You are a writer, not a publisher."));
  assert.ok(w.includes("Clinical-completeness protection."));
  assert.ok(w.includes("Pre-submission checklist"));
  assert.ok(w.includes("Integration transport envelope"));
  // The identity text itself embeds no reference bodies (registry supplies them).
  assert.ok(!w.includes("تشير مراجعة علمية جديدة"));
  // c1 clarification (owner-approved 2026-11-08): present, BETWEEN the verbatim
  // identity and the transport envelope, with the owner's example headline and
  // the not-a-template reminder; the identity version line stays untouched.
  const c1At = w.indexOf("Editorial clarification c1");
  assert.ok(c1At > w.indexOf("Pre-submission checklist"));
  assert.ok(c1At < w.indexOf("Integration transport envelope"));
  assert.ok(w.includes("Headline clarity."));
  assert.ok(w.includes("Body accessibility."));
  assert.ok(w.includes("دواء تجريبي يُظهر نتائج واعدة لعلاج مضاعفات خطيرة لدى أطفال مصابين بمرض وراثي نادر"));
  assert.ok(w.includes("NOT a headline template"));
  assert.ok(w.includes("accuracy, safety conditions and evidence limits win"));
  assert.ok(w.includes("Version: j1.0, 6 November 2026."));
});

// ---- Input sanitizer ---------------------------------------------------------

test("sanitizer: strips the related-links footer (جاسكايد class) and records it", () => {
  const res = sanitizeJamalInput(FIXTURE_BODY);
  assert.equal(res.applied, true);
  assert.equal(res.version, JAMAL_SANITIZER_VERSION);
  assert.ok(!res.text.includes(FOOTER_DECOY));
  assert.ok(!res.text.includes("محتوى ذو علاقة"));
  assert.ok(res.text.includes("1200 مشارك"));
});

test("sanitizer: a marker in the OPENING of a text never cuts (fail-safe), absence passes through", () => {
  const early = "محتوى ذو علاقة\n" + "نص خبري طويل. ".repeat(40);
  assert.equal(sanitizeJamalInput(early).applied, false);
  const none = "خبر عادي بلا تذييل. ".repeat(10);
  const res = sanitizeJamalInput(none);
  assert.equal(res.applied, false);
  assert.equal(res.text, none);
});

// ---- runJamal (model side; mocked transport) ---------------------------------

test("runJamal single_pass: valid reply parses; references appear only when configured", async () => {
  const chat = mockChat(GROUNDED_ARTICLE);
  const out = await runJamal(J0_STUB, { sourceText: "نص", sourceName: "س", sourceUrl: "https://x.test/a" }, { chat });
  assert.ok(out.ok);
  assert.equal(out.draft.article.title, GROUNDED_ARTICLE.title);
  assert.deepEqual(out.draft.reviewNotes, GROUNDED_ARTICLE.review_notes);
  // Stub has no reference examples → no benchmark text in the system prompt.
  assert.ok(!chat.calls[0].messages[0].content.includes("ألزهايمر"));

  const withRefs: JamalConfig = { ...J0_STUB, referenceExamples: ["benchmark-1-alzheimers"] };
  const chat2 = mockChat(GROUNDED_ARTICLE);
  await runJamal(withRefs, { sourceText: "نص", sourceName: "س", sourceUrl: "https://x.test/a" }, { chat: chat2 });
  assert.ok(chat2.calls[0].messages[0].content.includes("ألزهايمر"));
  // Stub (no styleAtlas) never carries the atlas.
  assert.ok(!chat2.calls[0].messages[0].content.includes("أطلس الأسلوب التحريري المعتمد"));
});

test("runJamal: a configured style atlas is appended AFTER the reference examples, with its warning framing", async () => {
  const { J1_0 } = await import("./jamal.ts");
  const { JAMAL_ATLAS_V1_2 } = await import("./jamalAtlas.ts");
  const chat = mockChat(GROUNDED_ARTICLE);
  const out = await runJamal(J1_0, { sourceText: "نص", sourceName: "س", sourceUrl: "https://x.test/a" }, { chat });
  assert.ok(out.ok);
  const system = chat.calls[0].messages[0].content;
  // Order: identity → approved references → atlas (each present exactly once).
  const refsAt = system.indexOf("أمثلة معتمدة على الأسلوب المطلوب");
  const atlasHeaderAt = system.indexOf("أطلس الأسلوب التحريري المعتمد");
  assert.ok(refsAt > 0 && atlasHeaderAt > refsAt);
  assert.ok(system.includes("لا تُنقل أي حقيقة أو رقم أو اسم أو تاريخ منه إلى أي خبر"));
  assert.ok(system.includes(JAMAL_ATLAS_V1_2));
  // The user message carries only the source; the atlas rides in the system prompt.
  assert.ok(!chat.calls[0].messages[1].content.includes("أطلس الأسلوب"));
});

test("runJamal: malformed JSON and missing fields are discrete failures", async () => {
  const badJson: JamalChat = async () => ({ ok: true, content: "ليس JSON" });
  const r1 = await runJamal(J0_STUB, { sourceText: "نص", sourceName: null, sourceUrl: "https://x.test" }, { chat: badJson });
  assert.ok(!r1.ok && r1.reason === "jamal_output_invalid_json");

  const missing = mockChat({ title: "عنوان", body: "نص" }); // no excerpt / review_notes
  const r2 = await runJamal(J0_STUB, { sourceText: "نص", sourceName: null, sourceUrl: "https://x.test" }, { chat: missing });
  assert.ok(!r2.ok && r2.reason === "jamal_output_schema_invalid");

  const down = mockChat(new Error("x"));
  const r3 = await runJamal(J0_STUB, { sourceText: "نص", sourceName: null, sourceUrl: "https://x.test" }, { chat: down });
  assert.ok(!r3.ok && r3.reason === "jamal_transport:network_error");
});

test("runJamal select_then_write: two calls; the writer call never sees the source text; selection is traced", async () => {
  const cfg: JamalConfig = {
    version: "j0.0-stub",
    technique: "select_then_write",
    instructions: { selection: "انتقِ الجوهر.", write: J0_STUB.instructions.write },
    referenceExamples: [],
  };
  const SENTINEL = "جملة-فريدة-من-المصدر-لا-تتكرر";
  const selection = { central_fact: "اعتماد دواء", why_it_matters: null, essential_facts: ["1200 مشارك"], must_keep_caveats: ["لا يعني الإتاحة"] };
  let call = 0;
  const calls: { content: string }[] = [];
  const chat: JamalChat = async (messages) => {
    calls.push({ content: messages[1].content });
    call++;
    return { ok: true, content: JSON.stringify(call === 1 ? selection : GROUNDED_ARTICLE) };
  };
  const out = await runJamal(cfg, { sourceText: `خبر. ${SENTINEL}.`, sourceName: "س", sourceUrl: "https://x.test" }, { chat });
  assert.ok(out.ok);
  assert.equal(call, 2);
  assert.ok(calls[0].content.includes(SENTINEL));
  assert.ok(!calls[1].content.includes(SENTINEL));
  assert.deepEqual(out.draft.trace.selection, selection);
});

// ---- writeJamalArticle (full integration: sanitizer → Jamal → validator) ------

test("writeJamalArticle clean: pending-shape outcome; Jamal reads SANITIZED text; validator and snapshot keep the FULL text", async () => {
  const chat = mockChat(GROUNDED_ARTICLE);
  const out = await writeJamalArticle({ verified: mkVerified(), ...BASE_INPUT, chat });
  assert.ok(out.ok);
  assert.equal(out.needsHumanReview, false);
  assert.equal(out.audit.writer_prompt_version, "j0.0-stub");
  assert.equal(out.audit.editor_outcome, "jamal_no_editor");
  assert.equal(out.writerAttempts, 1);
  // Jamal's prompt lacks the footer decoy; the audit snapshot (validation text)
  // retains it — source isolation exactly as designed.
  const userMsg = chat.calls[0].messages[1].content;
  assert.ok(!userMsg.includes(FOOTER_DECOY));
  assert.ok(out.jamalRun.source_snapshot.includes(FOOTER_DECOY));
  assert.equal(out.jamalRun.sanitizer_applied, true);
  assert.match(out.jamalRun.source_sha256, /^[0-9a-f]{64}$/);
  assert.match(out.jamalRun.jamal_input_sha256, /^[0-9a-f]{64}$/);
  assert.equal(out.jamalRun.accepted, true);
  assert.equal(out.jamalRun.validation_result, "clean");
  // Snapshot = the exact pipeline verifiedFactText construction (sync check).
  const v = mkVerified();
  const expected = [v.title, v.text, `المصدر: ${BASE_INPUT.sourceName}`, `النطاق: ${BASE_INPUT.registeredDomain}`, v.finalUrl].join("\n");
  assert.equal(out.jamalRun.source_snapshot, expected);
});

test("writeJamalArticle: an invented figure rejects via the EXTERNAL validator; the disabled repair is never a rewrite", async () => {
  const fabricated = { ...GROUNDED_ARTICLE, body: GROUNDED_ARTICLE.body + "\n\nوبلغ عدد المستفيدين 999 ألف شخص." };
  const chat = mockChat(fabricated);
  const out = await writeJamalArticle({ verified: mkVerified(), ...BASE_INPUT, chat });
  assert.ok(!out.ok);
  assert.match(out.rejection ?? "", /unsupported_number/);
  assert.ok(out.fidelity);
  assert.equal(out.fidelity!.repair_call_succeeded, false);
  assert.equal(out.jamalRun.accepted, false);
  assert.match(out.jamalRun.validation_result, /unsupported_number/);
});

test("writeJamalArticle: transport failure is a clean rejection with a full sidecar record", async () => {
  const chat = mockChat(new Error("down"));
  const out = await writeJamalArticle({ verified: mkVerified(), ...BASE_INPUT, chat });
  assert.ok(!out.ok);
  assert.equal(out.rejection, "jamal_transport:network_error");
  assert.equal(out.editorial, null);
  assert.equal(out.jamalRun.accepted, false);
  assert.equal(out.jamalRun.validation_result, "jamal_transport:network_error");
  assert.ok(out.jamalRun.source_sha256.length === 64);
});

test("writeJamalArticle: a figure supported only by an ambiguous source reading routes to human review (never silent)", async () => {
  const filler =
    "وأوضح الفريق أن الدراسة أجريت في عدة مراكز بحثية، وأن المشاركين خضعوا لمتابعة دورية منتظمة طوال فترة الدراسة. " +
    "وأشار الباحثون إلى أن هذه النتائج تحتاج إلى تأكيد في دراسات أوسع قبل اعتمادها في الممارسة السريرية، " +
    "وأن اختيار المشاركين جرى وفق معايير محددة أعلنها الفريق مسبقاً.";
  const v = mkVerified({
    text: `سجلت الدراسة 19 161 مشاركاً في المرحلة الأولى.\n\n${filler}\n\nوأكد الفريق أن النتائج أولية.`,
  });
  const draft = {
    ...GROUNDED_ARTICLE,
    title: "دراسة واسعة على المشاركين في المرحلة الأولى",
    excerpt: "النتائج أولية بحسب الفريق وتحتاج إلى تأكيد.",
    body: `سجلت الدراسة 19161 مشاركاً في المرحلة الأولى.\n\n${filler}\n\nوأكد الفريق أن النتائج أولية.`,
  };
  const chat = mockChat(draft);
  const out = await writeJamalArticle({ verified: v, ...BASE_INPUT, chat });
  assert.ok(out.ok, `expected ok, got ${JSON.stringify(!out.ok ? out.rejection : "")}`);
  assert.equal(out.needsHumanReview, true);
});
