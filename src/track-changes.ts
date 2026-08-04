import { computed, signal, type Signal, type WritableSignal } from "@angular/core";
import { diff, hasChanges, type ChangeSet, type DiffOptions } from "./diff.js";

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
 * Tracks changes made to a `WritableSignal` against a baseline snapshot taken
 * at call time. Built entirely on `signal()`/`computed()` — no `effect()`, no
 * injection context, no manual cleanup. Call it from anywhere: a component
 * field initializer, a service, a plain function.
 */
export function trackChanges<T>(source: WritableSignal<T>, options: DiffOptions = {}): ChangeTracker<T> {
  const baseline = signal<T>(structuredClone(source()));

  const changes = computed(() => diff(baseline(), source(), options));
  const changesPresent = computed(() => hasChanges(changes()));

  return {
    changes,
    hasChanges: changesPresent,
    commit: () => baseline.set(structuredClone(source())),
    revert: () => source.set(structuredClone(baseline())),
  };
}
