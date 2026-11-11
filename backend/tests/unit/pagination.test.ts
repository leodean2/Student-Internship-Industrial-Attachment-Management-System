import { describe, expect, it } from "vitest";
import { pageOf } from "../../src/shared/pagination";

const id = (row: { id: string }) => row.id;

describe("pageOf", () => {
  it("has no cursor when the rows fit exactly", () => {
    expect(pageOf([{ id: "a" }, { id: "b" }], 2, id)).toEqual({
      items: [{ id: "a" }, { id: "b" }],
      nextCursor: null,
    });
  });

  it("returns the last returned id as the cursor and drops the lookahead row", () => {
    expect(pageOf([{ id: "a" }, { id: "b" }, { id: "c" }], 2, id)).toEqual({
      items: [{ id: "a" }, { id: "b" }],
      nextCursor: "b",
    });
  });

  it("handles an empty result", () => {
    expect(pageOf([], 5, id)).toEqual({ items: [], nextCursor: null });
  });
});
