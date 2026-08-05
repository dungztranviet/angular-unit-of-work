import { describe, expect, it } from "vitest";
import { clonePreservingInstances, currentValues, diff, hasChanges } from "../src/diff.js";

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

  describe("Map / Set / RegExp / class instances", () => {
    it("diffs Map entries as added/removed/modified", () => {
      const baseline = { tags: new Map([["a", 1], ["b", 2]]) };
      const current = { tags: new Map([["b", 20], ["c", 3]]) };

      const result = diff(baseline, current);

      expect(result).toEqual({
        tags: {
          c: { action: "added", value: 3 },
          a: { action: "removed", value: 1 },
          b: { action: "modified", value: 20, previousValue: 2 },
        },
      });
    });

    it("treats two Maps with identical entries as unchanged", () => {
      const baseline = { tags: new Map([["a", 1]]) };
      const current = { tags: new Map([["a", 1]]) };
      expect(diff(baseline, current)).toBeUndefined();
    });

    it("diffs Set entries as added/removed, never modified", () => {
      const baseline = { roles: new Set(["admin", "editor"]) };
      const current = { roles: new Set(["editor", "viewer"]) };

      const result = diff(baseline, current);

      expect(result).toEqual({
        roles: {
          viewer: { action: "added", value: "viewer" },
          admin: { action: "removed", value: "admin" },
        },
      });
    });

    it("compares RegExp by source and flags, not by reference", () => {
      expect(diff({ pattern: /abc/gi }, { pattern: /abc/gi })).toBeUndefined();

      const result = diff({ pattern: /abc/g }, { pattern: /abc/gi });
      expect(result?.pattern).toMatchObject({ action: "modified" });
    });

    class Money {
      constructor(public cents: number) {}
    }

    it("falls back to reference equality for class instances by default", () => {
      const a = new Money(100);
      const b = new Money(100);
      // Same content, different instance — reference equality says "changed".
      // This is the documented default; pass `isEqual` to change it.
      expect(diff({ price: a }, { price: b })?.price).toMatchObject({ action: "modified" });
      expect(diff({ price: a }, { price: a })).toBeUndefined();
    });

    it("accepts a custom isEqual for class instances", () => {
      const a = new Money(100);
      const b = new Money(100);
      const c = new Money(150);

      const isEqual = (x: unknown, y: unknown) => (x instanceof Money && y instanceof Money ? x.cents === y.cents : Object.is(x, y));

      expect(diff({ price: a }, { price: b }, { isEqual })).toBeUndefined();
      expect(diff({ price: a }, { price: c }, { isEqual })?.price).toEqual({
        action: "modified",
        value: c,
        previousValue: a,
      });
    });
  });

  describe("circular references", () => {
    it("does not stack-overflow on a self-referential object at the root", () => {
      const baseline: Record<string, unknown> = { name: "A" };
      baseline["self"] = baseline;
      const current: Record<string, unknown> = { name: "B" };
      current["self"] = current;

      const result = diff(baseline, current);
      expect(result).toEqual({ name: { action: "modified", value: "B", previousValue: "A" } });
    });

    it("does not stack-overflow on a cycle two levels deep", () => {
      const baseline: Record<string, unknown> = { name: "A" };
      const baselineChild: Record<string, unknown> = { parent: baseline };
      baseline["child"] = baselineChild;

      const current: Record<string, unknown> = { name: "B" };
      const currentChild: Record<string, unknown> = { parent: current };
      current["child"] = currentChild;

      const result = diff(baseline, current);
      expect(result).toEqual({ name: { action: "modified", value: "B", previousValue: "A" } });
    });

    it("does not stack-overflow on a cycle inside an array item", () => {
      const baseline: Record<string, unknown> = { id: 1, name: "A" };
      baseline["self"] = [baseline];
      const current: Record<string, unknown> = { id: 1, name: "B" };
      current["self"] = [current];

      const result = diff([baseline], [current]);
      expect(result).toEqual({
        "1": { name: { action: "modified", value: "B", previousValue: "A" } },
      });
    });
  });

  describe("arrayStrategy: 'sequence'", () => {
    // A pure reversal is NOT "no diff": every pair of elements swaps relative
    // order, so no two elements can stay matched — same reason `git diff`
    // shows a fully-reversed line order as many changed lines, not zero.
    it("still needs one remove+add per element that loses its relative order", () => {
      const result = diff([1, 2, 3], [3, 2, 1], { arrayStrategy: "sequence" });
      expect(result).toEqual({
        "-0": { action: "removed", value: 1 },
        "-1": { action: "removed", value: 2 },
        "+1": { action: "added", value: 2 },
        "+2": { action: "added", value: 1 },
      });
    });

    it("leaves items that keep their relative order untouched, even without an id", () => {
      const a = { name: "a" };
      const b = { name: "b" };
      // "a" moves from front to back; "b" keeps the same position relative
      // to "a" either way, so it never shows up in the diff at all.
      const result = diff([a, b], [b, a], { arrayStrategy: "sequence" });
      expect(result).toEqual({
        "-0": { action: "removed", value: a },
        "+1": { action: "added", value: a },
      });
    });

    it("reports a genuinely different item as removed+added, not modified, without an id", () => {
      const a = { name: "a" };
      const b = { name: "b" };
      const x = { name: "x" };

      // [a, b] -> [x, a]: "b" is replaced by "x", "a" just moves.
      const result = diff([a, b], [x, a], { arrayStrategy: "sequence" });

      expect(result).toEqual({
        "+0": { action: "added", value: x },
        "-1": { action: "removed", value: b },
      });
    });

    it("byId remains the default: the same reorder reports every shifted item as modified", () => {
      const result = diff([1, 2, 3], [3, 2, 1]);
      expect(result).toEqual({
        "#0": { action: "modified", value: 3, previousValue: 1 },
        "#2": { action: "modified", value: 1, previousValue: 3 },
      });
    });
  });

  describe("clonePreservingInstances", () => {
    class Money {
      constructor(public cents: number) {}
    }

    it("deep-clones arrays, plain objects, Date, Map, and Set", () => {
      const original = {
        list: [1, 2],
        nested: { a: 1 },
        when: new Date("2026-01-01T00:00:00Z"),
        map: new Map([["a", 1]]),
        set: new Set([1, 2]),
      };

      const clone = clonePreservingInstances(original);

      expect(clone).not.toBe(original);
      expect(clone.list).not.toBe(original.list);
      expect(clone.nested).not.toBe(original.nested);
      expect(clone.when).not.toBe(original.when);
      expect(clone.map).not.toBe(original.map);
      expect(clone.set).not.toBe(original.set);
      expect(clone).toEqual(original);
    });

    it("does NOT turn a class instance into a plain object (unlike structuredClone)", () => {
      const original = { price: new Money(1000) };
      const clone = clonePreservingInstances(original);

      // Same reference on purpose: class instances are treated as opaque and
      // are never traversed, so there is nothing to deep-clone into.
      expect(clone.price).toBe(original.price);
      expect(clone.price instanceof Money).toBe(true);
    });
  });

  describe("currentValues", () => {
    it("returns undefined when there is no diff", () => {
      expect(currentValues(diff({ a: 1 }, { a: 1 }))).toBeUndefined();
    });

    it("drops action and previousValue from a flat object diff", () => {
      const result = currentValues(diff({ name: "A", age: 30 }, { name: "B", age: 30 }));
      expect(result).toEqual({ name: "B" });
    });

    it("recurses into nested objects", () => {
      const result = currentValues(diff({ vessel: { name: "Alpha" } }, { vessel: { name: "Beta" } }));
      expect(result).toEqual({ vessel: { name: "Beta" } });
    });

    it("maps a removed array item to null instead of its old content", () => {
      const baseline = [{ id: 1, name: "one" }, { id: 2, name: "two" }];
      const current = [{ id: 2, name: "two" }, { id: 3, name: "three" }];

      const result = currentValues(diff(baseline, current));

      expect(result).toEqual({
        "3": { id: 3, name: "three" }, // added -> the value itself
        "1": null, // removed -> null, not the deleted item
      });
    });

    it("uses a value change even when the tracked data has its own 'action' field", () => {
      // Regression: isValueChange() used to duck-type on `"action" in node`,
      // which would misfire on data that itself has a field named "action".
      const result = currentValues(
        diff({ workflow: { action: "draft" } }, { workflow: { action: "published" } }),
      );
      expect(result).toEqual({ workflow: { action: "published" } });
    });
  });
});
