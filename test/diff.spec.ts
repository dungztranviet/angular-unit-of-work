import { describe, expect, it } from "vitest";
import { diff, hasChanges } from "../src/diff.js";

describe("diff", () => {
  it("returns undefined when nothing changed", () => {
    const result = diff({ name: "A" }, { name: "A" });
    expect(result).toBeUndefined();
    expect(hasChanges(result)).toBe(false);
  });

  it("reports a modified primitive property", () => {
    const result = diff({ name: "A", age: 30 }, { name: "B", age: 30 });
    expect(result).toEqual({
      name: { action: "modified", value: "B", previousValue: "A" },
    });
  });

  it("is self-cancelling: reverting a field back to baseline produces no diff", () => {
    const baseline = { name: "A" };
    const editedThenReverted = { name: "A" };
    expect(diff(baseline, editedThenReverted)).toBeUndefined();
  });

  it("recurses into nested objects", () => {
    const baseline = { vessel: { name: "MV Alpha" } };
    const current = { vessel: { name: "MV Beta" } };
    const result = diff(baseline, current);
    expect(result).toEqual({
      vessel: {
        name: { action: "modified", value: "MV Beta", previousValue: "MV Alpha" },
      },
    });
  });

  it("compares Date properties by value, not by reference", () => {
    const baseline = { updatedAt: new Date("2026-01-01T00:00:00Z") };
    const current = { updatedAt: new Date("2026-01-01T00:00:00Z") };
    expect(diff(baseline, current)).toBeUndefined();

    const changed = { updatedAt: new Date("2026-02-01T00:00:00Z") };
    const result = diff(baseline, changed);
    expect(result?.updatedAt).toMatchObject({ action: "modified" });
  });

  it("skips properties in the ignore list, at any depth", () => {
    const baseline = { identifier: "a", vessel: { identifier: "x", name: "Alpha" } };
    const current = { identifier: "b", vessel: { identifier: "y", name: "Alpha" } };
    const result = diff(baseline, current, { ignore: ["identifier"] });
    expect(result).toBeUndefined();
  });

  describe("arrays", () => {
    it("detects added and removed items by id", () => {
      const baseline = [{ id: 1, name: "one" }, { id: 2, name: "two" }];
      const current = [{ id: 2, name: "two" }, { id: 3, name: "three" }];

      const result = diff(baseline, current);

      expect(result).toEqual({
        "3": { action: "added", value: { id: 3, name: "three" } },
        "1": { action: "removed", value: { id: 1, name: "one" } },
      });
    });

    it("detects a modified property on an existing item", () => {
      const baseline = [{ id: 1, name: "one" }];
      const current = [{ id: 1, name: "uno" }];

      const result = diff(baseline, current);

      expect(result).toEqual({
        "1": { name: { action: "modified", value: "uno", previousValue: "one" } },
      });
    });

    it("adding then removing the same item in one diff cancels out", () => {
      const baseline = [{ id: 1, name: "one" }];
      const current = [{ id: 1, name: "one" }];
      expect(diff(baseline, current)).toBeUndefined();
    });

    it("supports a custom idKey", () => {
      const baseline = [{ uuid: "a", name: "one" }];
      const current = [{ uuid: "a", name: "uno" }];

      const result = diff(baseline, current, { idKey: "uuid" });

      expect(result).toEqual({
        a: { name: { action: "modified", value: "uno", previousValue: "one" } },
      });
    });

    it("falls back to positional index when items have no id", () => {
      const result = diff([1, 2, 3], [1, 5, 3]);
      expect(result).toEqual({
        "#1": { action: "modified", value: 5, previousValue: 2 },
      });
    });
  });

  it("tracking a signal that is itself a bare array works at the top level", () => {
    const baseline = [{ id: 1, name: "one" }];
    const current = [{ id: 1, name: "one" }, { id: 2, name: "two" }];
    const result = diff(baseline, current);
    expect(result).toEqual({
      "2": { action: "added", value: { id: 2, name: "two" } },
    });
  });

  it("wraps a top-level primitive change under 'root'", () => {
    expect(diff(1, 2)).toEqual({ root: { action: "modified", value: 2, previousValue: 1 } });
    expect(diff(1, 1)).toBeUndefined();
  });
});
