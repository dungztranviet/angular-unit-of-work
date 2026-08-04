import { computed, signal, type Signal, type WritableSignal } from "@angular/core";
import { diff, hasChanges, type ChangeSet, type DiffOptions } from "./diff.js";

/** A comparison function compatible with {@link TrackChangesOptions.compare}. */
export type Comparator<T> = (baseline: T, current: T, options: DiffOptions) => ChangeSet | undefined;

export interface TrackChangesOptions<T> extends DiffOptions {
  /**
   * Swap in a different comparison function — e.g. a wrapper around
   * `fast-json-patch`, `microdiff`, or your own logic — instead of the bundled
   * {@link diff}. `trackChanges` itself doesn't know or care how the diff is
   * computed; it only turns whatever comes back into Signals.
   */
  compare?: Comparator<T>;
}

/**
 * Reactive handle returned by {@link trackChanges}. `changes` and `hasChanges`
 * are plain Angular Signals — read them in a template, a computed, or an effect
 * exactly like any other signal.
 */
export interface ChangeTracker<T> {
  readonly changes: Signal<ChangeSet | undefined>;
  readonly hasChanges: Signal<boolean>;
  /** Moves the baseline to the current value — call this after a successful save. */
  commit(): void;
  /** Discards in-progress edits by writing the baseline back into the source signal. */
  revert(): void;
}

/**
 * Turns a `WritableSignal` into a reactive change tracker: a baseline snapshot
 * taken at call time, and a `changes`/`hasChanges` pair kept in sync with it
 * via `computed()` — no `effect()`, no injection context, no manual cleanup.
 * Call it from anywhere: a component field initializer, a service, a plain
 * function. The actual diffing is delegated to {@link TrackChangesOptions.compare}
 * (the bundled {@link diff} by default) — this function is the Signals
 * plumbing around it, not a diffing algorithm in its own right.
 */
export function trackChanges<T>(source: WritableSignal<T>, options: TrackChangesOptions<T> = {}): ChangeTracker<T> {
  const compare = options.compare ?? diff;
  const baseline = signal<T>(structuredClone(source()));

  const changes = computed(() => compare(baseline(), source(), options));
  const changesPresent = computed(() => hasChanges(changes()));

  return {
    changes,
    hasChanges: changesPresent,
    commit: () => baseline.set(structuredClone(source())),
    revert: () => source.set(structuredClone(baseline())),
  };
}
