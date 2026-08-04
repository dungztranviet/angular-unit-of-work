import { signal } from "@angular/core";
import { describe, expect, it } from "vitest";
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
});
