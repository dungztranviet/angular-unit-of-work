import { signal } from "@angular/core";
import { describe, expect, it, vi } from "vitest";
import { trackChanges } from "../src/track-changes.js";

interface Column {
  id: number;
  displayName: string;
}

describe("trackChanges", () => {
  it("starts with no changes", () => {
    const data = signal<Column[]>([{ id: 1, displayName: "Name" }]);
    const tracker = trackChanges(data);

    expect(tracker.hasChanges()).toBe(false);
    expect(tracker.changes()).toBeUndefined();
  });

  it("reacts when the source signal changes", () => {
    const data = signal<Column[]>([{ id: 1, displayName: "Name" }]);
    const tracker = trackChanges(data, { idKey: "id" });

    data.update((items) => items.map((item) => (item.id === 1 ? { ...item, displayName: "Full name" } : item)));

    expect(tracker.hasChanges()).toBe(true);
    expect(tracker.changes()).toEqual({
      "1": { displayName: { action: "modified", value: "Full name", previousValue: "Name" } },
    });
  });

  it("clears automatically when the edit is undone by hand", () => {
    const data = signal<Column[]>([{ id: 1, displayName: "Name" }]);
    const tracker = trackChanges(data);

    data.update((items) => items.map((item) => ({ ...item, displayName: "Full name" })));
    expect(tracker.hasChanges()).toBe(true);

    data.update((items) => items.map((item) => ({ ...item, displayName: "Name" })));
    expect(tracker.hasChanges()).toBe(false);
  });

  it("commit() moves the baseline to the current value", () => {
    const data = signal<Column[]>([{ id: 1, displayName: "Name" }]);
    const tracker = trackChanges(data);

    data.update((items) => items.map((item) => ({ ...item, displayName: "Full name" })));
    expect(tracker.hasChanges()).toBe(true);

    tracker.commit();
    expect(tracker.hasChanges()).toBe(false);

    data.update((items) => items.map((item) => ({ ...item, displayName: "Even fuller name" })));
    expect(tracker.changes()).toEqual({
      "1": { displayName: { action: "modified", value: "Even fuller name", previousValue: "Full name" } },
    });
  });

  it("revert() writes the baseline back into the source signal", () => {
    const data = signal<Column[]>([{ id: 1, displayName: "Name" }]);
    const tracker = trackChanges(data);

    data.update((items) => items.map((item) => ({ ...item, displayName: "Full name" })));
    tracker.revert();

    expect(data()).toEqual([{ id: 1, displayName: "Name" }]);
    expect(tracker.hasChanges()).toBe(false);
  });

  it("tracks added and removed array items", () => {
    const data = signal<Column[]>([{ id: 1, displayName: "Name" }]);
    const tracker = trackChanges(data);

    data.set([{ id: 2, displayName: "Other" }]);

    expect(tracker.changes()).toEqual({
      "2": { action: "added", value: { id: 2, displayName: "Other" } },
      "1": { action: "removed", value: { id: 1, displayName: "Name" } },
    });
  });

  it("preserves class instances in the baseline (regression: structuredClone used to strip them)", () => {
    class Money {
      constructor(public cents: number) {}
    }

    const state = signal<{ price: Money }>({ price: new Money(1000) });
    const isEqual = (a: unknown, b: unknown) =>
      a instanceof Money && b instanceof Money ? a.cents === b.cents : Object.is(a, b);
    const tracker = trackChanges(state, { isEqual });

    // Same value, brand-new instance. If the baseline snapshot silently turned
    // the original Money into a plain object, `b instanceof Money` below would
    // be false for the baseline side and isEqual would wrongly report a change.
    state.update((current) => ({ ...current, price: new Money(1000) }));

    expect(tracker.hasChanges()).toBe(false);

    state.update((current) => ({ ...current, price: new Money(2000) }));
    expect(tracker.hasChanges()).toBe(true);
  });

  it("delegates to a custom compare function instead of the bundled diff", () => {
    const data = signal<Column[]>([{ id: 1, displayName: "Name" }]);
    const compare = vi.fn(() => ({ custom: { action: "modified" as const, value: "stub" } }));
    const tracker = trackChanges(data, { compare });

    data.update((items) => items.map((item) => ({ ...item, displayName: "Full name" })));

    expect(tracker.changes()).toEqual({ custom: { action: "modified", value: "stub" } });
    expect(compare).toHaveBeenCalledWith(
      [{ id: 1, displayName: "Name" }],
      [{ id: 1, displayName: "Full name" }],
      { compare },
    );
  });

  it("currentValues() mirrors changes() with action/previousValue dropped", () => {
    const data = signal<Column[]>([{ id: 1, displayName: "Name" }]);
    const tracker = trackChanges(data);

    expect(tracker.currentValues()).toBeUndefined();

    data.update((items) => items.map((item) => ({ ...item, displayName: "Full name" })));
    expect(tracker.currentValues()).toEqual({ "1": { displayName: "Full name" } });

    data.set([{ id: 2, displayName: "Other" }]);
    expect(tracker.currentValues()).toEqual({
      "2": { id: 2, displayName: "Other" },
      "1": null, // removed - no "current value" to report
    });
  });

  it("currentValues() also works with a custom compare (falls back to structural detection)", () => {
    const data = signal<Column[]>([{ id: 1, displayName: "Name" }]);
    const compare = () => ({ custom: { action: "modified" as const, value: "stub" } });
    const tracker = trackChanges(data, { compare });

    data.update((items) => items.map((item) => ({ ...item, displayName: "Full name" })));

    expect(tracker.currentValues()).toEqual({ custom: "stub" });
  });
});
