// Deterministic unit tests for lead-board selection (DB/DC) and §DUP/§DUP-V.
// Runs on plain Node (type stripping): `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectLeadBoard, dedupSectionItems, LEAD_BOARD_COUNTS } from "./leadBoard.ts";

type AnyContent = Parameters<typeof selectLeadBoard>[0][number];

/** Minimal story factory; `pool` order (newest first) is the recency order. */
const story = (id: string, opts: Partial<AnyContent> = {}) =>
  ({ id, is_breaking: false, cover_image_url: null, ...opts }) as AnyContent;

const ids = (list: { id: string }[]) => list.map((c) => c.id);

// ---------------------------------------------------------------- selectLeadBoard

test("DB ranking: breaking first, then cover image, then recency (stable)", () => {
  const pool = [
    story("plain-new"),
    story("cover-new", { cover_image_url: "x" as never }),
    story("breaking-old", { is_breaking: true as never }),
    story("cover-old", { cover_image_url: "x" as never }),
  ];
  const board = selectLeadBoard(pool, []);
  assert.deepEqual(ids(board.supporting), ["breaking-old", "cover-new"]);
});

test("hero stories are excluded from every board slot", () => {
  const hero = [story("h1"), story("h2")];
  const pool = [...hero, ...Array.from({ length: 12 }, (_, i) => story(`p${i}`))];
  const board = selectLeadBoard(pool, hero);
  const all = [...ids(board.supporting), ...ids(board.latest), ...ids(board.more)];
  assert.ok(!all.includes("h1") && !all.includes("h2"));
});

test("no story fills two board slots; counts match the approved composition", () => {
  const pool = Array.from({ length: 20 }, (_, i) =>
    story(`p${i}`, { cover_image_url: (i % 2 ? "x" : null) as never }),
  );
  const board = selectLeadBoard(pool, pool.slice(0, 3));
  const all = [...ids(board.supporting), ...ids(board.latest), ...ids(board.more)];
  assert.equal(new Set(all).size, all.length);
  assert.equal(board.supporting.length, LEAD_BOARD_COUNTS.supporting);
  assert.equal(board.latest.length, LEAD_BOARD_COUNTS.latest);
  assert.equal(board.more.length, LEAD_BOARD_COUNTS.more);
});

test("«الأحدث» takes the most recent stories left after hero + supporting", () => {
  const pool = Array.from({ length: 12 }, (_, i) => story(`p${i}`));
  const board = selectLeadBoard(pool, []);
  // No breaking/cover: supporting = p0,p1 (recency), latest = next four.
  assert.deepEqual(ids(board.latest), ["p2", "p3", "p4", "p5"]);
  assert.deepEqual(ids(board.more), ["p6", "p7", "p8"]);
});

test("selection is deterministic: same input, same output", () => {
  const pool = Array.from({ length: 15 }, (_, i) =>
    story(`p${i}`, { is_breaking: (i === 7) as never, cover_image_url: (i % 3 ? "x" : null) as never }),
  );
  const a = selectLeadBoard(pool, pool.slice(0, 2));
  const b = selectLeadBoard(pool, pool.slice(0, 2));
  assert.deepEqual(a, b);
});

// ------------------------------------------------------------- dedupSectionItems

const sets = (board: string[], hero: string[]) =>
  [new Set(board), new Set(hero)] as [ReadonlySet<string>, ReadonlySet<string>];

test("default: strict dedup, capped at items_limit", () => {
  const own = [story("a"), story("b"), story("c"), story("d")];
  const [board, hero] = sets(["b"], []);
  assert.deepEqual(ids(dedupSectionItems(own, 2, board, hero)), ["a", "c"]);
});

test("§DUP fallback: a short section re-admits only its own hero stories", () => {
  const own = [story("h"), story("s"), story("x")];
  const [board, hero] = sets(["h", "s"], ["h"]);
  // strict leaves only x (short of limit 3) → hero story h returns; s (non-hero board) never does.
  assert.deepEqual(ids(dedupSectionItems(own, 3, board, hero)), ["h", "x"]);
});

test("§DUP-V: a section fully consumed by non-hero board slots never disappears", () => {
  const own = [story("a"), story("b")];
  const [board, hero] = sets(["a", "b"], []);
  assert.deepEqual(ids(dedupSectionItems(own, 3, board, hero)), ["a", "b"]);
});

test("§DUP-V still respects items_limit", () => {
  const own = [story("a"), story("b"), story("c")];
  const [board, hero] = sets(["a", "b", "c"], []);
  assert.deepEqual(ids(dedupSectionItems(own, 2, board, hero)), ["a", "b"]);
});

test("a genuinely empty section stays empty (visibility rule needs content)", () => {
  const [board, hero] = sets(["a"], []);
  assert.deepEqual(dedupSectionItems([], 4, board, hero), []);
});

test("dedup is deterministic: same input, same output", () => {
  const own = [story("h"), story("s"), story("x"), story("y")];
  const [board, hero] = sets(["h", "s"], ["h"]);
  assert.deepEqual(
    dedupSectionItems(own, 3, board, hero),
    dedupSectionItems(own, 3, board, hero),
  );
});
