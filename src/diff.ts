/** What happened to a value between the baseline snapshot and the current one. */
export type ChangeAction = "added" | "removed" | "modified";

/** A single changed value — a leaf in a {@link ChangeSet} tree. */
export interface ValueChange<T = unknown> {
  action: ChangeAction;
  value: T;
  previousValue?: T;
}

/** A node in the diff tree: either a leaf change or a nested set of changes. */
export type ChangeNode = ValueChange | ChangeSet;

/**
 * The diff between two snapshots. Keys are either object property names,
 * an array item's id (see {@link DiffOptions.idKey}), a Map's key, or a
 * position (see {@link DiffOptions.arrayStrategy}). Only keys that actually
 * changed are present — an unchanged branch never appears here.
 */
export interface ChangeSet {
  [key: string]: ChangeNode;
}

export interface DiffOptions {
  /** Property used to match array items between the two snapshots. Default: `"id"`. */
  idKey?: string;
  /** Property names to skip everywhere, at any depth. */
  ignore?: string[];
  /**
   * How to diff arrays.
   * - `"byId"` (default): match items across snapshots by {@link idKey} (or
   *   positional index as a fallback). Fast, but a pure reorder of items with
   *   no id looks like every shifted item was modified.
   * - `"sequence"`: align items by content (via {@link isEqual}, applied
   *   recursively), the way `git diff` aligns lines. A pure reorder produces
   *   no diff at all; a genuinely different item is reported as one `removed`
   *   plus one `added`, never as a per-property change, since there's no id
   *   to say "this is the same item, edited."
   */
  arrayStrategy?: "byId" | "sequence";
  /**
   * Equality check used for anything that isn't an array, plain object,
   * `Date`, `Map`, `Set`, or `RegExp` — most commonly, class instances and
   * primitives. Default: `Object.is`.
   */
  isEqual?: (baseline: unknown, current: unknown) => boolean;
}

interface ResolvedOptions {
  idKey: string;
  ignore: string[];
  arrayStrategy: "byId" | "sequence";
  isEqual: (baseline: unknown, current: unknown) => boolean;
  /** Stack of (baseline, current) pairs currently being compared, for cycle detection. */
  ancestors: Array<[object, object]>;
}

function resolveOptions(options: DiffOptions): ResolvedOptions {
  return {
    idKey: options.idKey ?? "id",
    ignore: options.ignore ?? [],
    arrayStrategy: options.arrayStrategy ?? "byId",
    isEqual: options.isEqual ?? Object.is,
    ancestors: [],
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value) || value instanceof Date || value instanceof Map || value instanceof Set || value instanceof RegExp) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Every `ValueChange` leaf is tagged with this non-enumerable symbol so it
 * can be told apart from a nested `ChangeSet` reliably — checking for an
 * `"action"` property would misfire if the tracked data itself has a field
 * literally named `action`. The symbol never appears in `Object.keys()`,
 * `JSON.stringify()`, or the public `ChangeSet` shape.
 */
const VALUE_CHANGE_TAG = Symbol("angular-unit-of-work.ValueChange");

function tagValueChange(change: ValueChange): ValueChange {
  Object.defineProperty(change, VALUE_CHANGE_TAG, { value: true, enumerable: false });
  return change;
}

/**
 * True for anything produced by {@link modifiedChange}/{@link addedChange}/
 * {@link removedChange} (checked via the tag, with certainty) — and, as a
 * fallback for `ChangeSet`s coming from a custom `compare` (which has no way
 * to attach that tag), for anything shaped like `{ action, value }`. The
 * fallback carries the same narrow collision risk the tag exists to avoid,
 * but only for changes this module didn't build itself.
 */
function isValueChange(node: ChangeNode): node is ValueChange {
  const tagged = (node as Record<PropertyKey, unknown>)[VALUE_CHANGE_TAG];
  if (tagged !== undefined) return Boolean(tagged);
  const candidate = node as Record<string, unknown>;
  return "action" in candidate && "value" in candidate;
}

function modifiedChange(value: unknown, previousValue: unknown): ValueChange {
  return tagValueChange({ action: "modified", value, previousValue });
}

function addedChange(value: unknown): ValueChange {
  return tagValueChange({ action: "added", value });
}

function removedChange(value: unknown): ValueChange {
  return tagValueChange({ action: "removed", value });
}

function sameDate(a: Date, b: Date): boolean {
  return a.getTime() === b.getTime();
}

function sameRegExp(a: RegExp, b: RegExp): boolean {
  return a.source === b.source && a.flags === b.flags;
}

/**
 * Prevents infinite recursion on circular references: if this exact
 * (baseline, current) pair is already an ancestor of itself in the current
 * recursion path, stop here instead of recursing again. Does not affect
 * legitimate shared references that don't loop back on themselves.
 */
function withCycleGuard(
  baseline: object,
  current: object,
  options: ResolvedOptions,
  compute: () => ChangeSet | undefined,
): ChangeSet | undefined {
  if (options.ancestors.some(([b, c]) => b === baseline && c === current)) {
    return undefined;
  }
  options.ancestors.push([baseline, current]);
  try {
    return compute();
  } finally {
    options.ancestors.pop();
  }
}

function itemKey(item: unknown, index: number, idKey: string): string {
  if (isPlainObject(item) && item[idKey] !== undefined) {
    return String(item[idKey]);
  }
  return `#${index}`;
}

function diffArrayById(baseline: unknown[], current: unknown[], options: ResolvedOptions): ChangeSet | undefined {
  return withCycleGuard(baseline, current, options, () => {
    const before = new Map<string, unknown>();
    baseline.forEach((item, index) => before.set(itemKey(item, index, options.idKey), item));

    const after = new Map<string, unknown>();
    current.forEach((item, index) => after.set(itemKey(item, index, options.idKey), item));

    const result: ChangeSet = {};

    for (const [key, item] of after) {
      if (!before.has(key)) {
        result[key] = addedChange(item);
      }
    }

    for (const [key, item] of before) {
      if (!after.has(key)) {
        result[key] = removedChange(item);
      }
    }

    for (const [key, currentItem] of after) {
      if (!before.has(key)) continue; // already recorded as "added"
      const itemDiff = diffValue(before.get(key), currentItem, options);
      if (itemDiff !== undefined) {
        result[key] = itemDiff;
      }
    }

    return Object.keys(result).length > 0 ? result : undefined;
  });
}

/**
 * Aligns two arrays by content (longest common subsequence, keyed on
 * {@link ResolvedOptions.isEqual} applied recursively) instead of by id.
 * Keys removed items by their baseline position (`-N`) and added items by
 * their current position (`+N`) — mirroring unified diff's `-`/`+` — since
 * there's no id to key them by.
 */
function diffArraySequence(baseline: unknown[], current: unknown[], options: ResolvedOptions): ChangeSet | undefined {
  return withCycleGuard(baseline, current, options, () => {
    const n = baseline.length;
    const m = current.length;
    const equal = (a: unknown, b: unknown) => diffValue(a, b, options) === undefined;

    // dp[i][j] = length of the LCS of baseline[i:] and current[j:].
    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        const dpRowI = dp[i];
        const dpRowINext = dp[i + 1];
        if (!dpRowI || !dpRowINext) continue;
        dpRowI[j] = equal(baseline[i], current[j])
          ? (dpRowINext[j + 1] ?? 0) + 1
          : Math.max(dpRowINext[j] ?? 0, dpRowI[j + 1] ?? 0);
      }
    }

    const result: ChangeSet = {};
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (equal(baseline[i], current[j])) {
        i++;
        j++;
      } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
        result[`-${i}`] = removedChange(baseline[i]);
        i++;
      } else {
        result[`+${j}`] = addedChange(current[j]);
        j++;
      }
    }
    while (i < n) {
      result[`-${i}`] = removedChange(baseline[i]);
      i++;
    }
    while (j < m) {
      result[`+${j}`] = addedChange(current[j]);
      j++;
    }

    return Object.keys(result).length > 0 ? result : undefined;
  });
}

function diffArray(baseline: unknown[], current: unknown[], options: ResolvedOptions): ChangeSet | undefined {
  return options.arrayStrategy === "sequence"
    ? diffArraySequence(baseline, current, options)
    : diffArrayById(baseline, current, options);
}

function diffObject(
  baseline: Record<string, unknown>,
  current: Record<string, unknown>,
  options: ResolvedOptions,
): ChangeSet | undefined {
  return withCycleGuard(baseline, current, options, () => {
    const keys = new Set([...Object.keys(baseline), ...Object.keys(current)]);
    const result: ChangeSet = {};

    for (const key of keys) {
      if (options.ignore.includes(key)) continue;
      const nodeDiff = diffValue(baseline[key], current[key], options);
      if (nodeDiff !== undefined) {
        result[key] = nodeDiff;
      }
    }

    return Object.keys(result).length > 0 ? result : undefined;
  });
}

function diffMap(baseline: Map<unknown, unknown>, current: Map<unknown, unknown>, options: ResolvedOptions): ChangeSet | undefined {
  return withCycleGuard(baseline, current, options, () => {
    const result: ChangeSet = {};

    for (const [key, value] of current) {
      if (!baseline.has(key)) {
        result[String(key)] = addedChange(value);
      }
    }

    for (const [key, value] of baseline) {
      if (!current.has(key)) {
        result[String(key)] = removedChange(value);
      }
    }

    for (const [key, currentValue] of current) {
      if (!baseline.has(key)) continue; // already recorded as "added"
      const nodeDiff = diffValue(baseline.get(key), currentValue, options);
      if (nodeDiff !== undefined) {
        result[String(key)] = nodeDiff;
      }
    }

    return Object.keys(result).length > 0 ? result : undefined;
  });
}

/**
 * A `Set` has no sub-properties to change, so entries are only ever
 * `added`/`removed`, never `modified`. Primitive entries are keyed by their
 * own value (unique by definition — a `Set` can't contain a duplicate);
 * object entries get a counter-based key, since a `Set` gives them no
 * identity beyond reference.
 */
function diffSet(baseline: Set<unknown>, current: Set<unknown>, options: ResolvedOptions): ChangeSet | undefined {
  return withCycleGuard(baseline, current, options, () => {
    const result: ChangeSet = {};
    let counter = 0;
    const keyFor = (value: unknown): string => {
      if (typeof value === "object" && value !== null) {
        return `#${counter++}`;
      }
      return String(value);
    };

    for (const value of current) {
      if (!baseline.has(value)) {
        result[keyFor(value)] = addedChange(value);
      }
    }
    for (const value of baseline) {
      if (!current.has(value)) {
        result[keyFor(value)] = removedChange(value);
      }
    }

    return Object.keys(result).length > 0 ? result : undefined;
  });
}

function isContainerPair(a: unknown, b: unknown): boolean {
  return (
    (Array.isArray(a) && Array.isArray(b)) ||
    (isPlainObject(a) && isPlainObject(b)) ||
    (a instanceof Map && b instanceof Map) ||
    (a instanceof Set && b instanceof Set)
  );
}

function diffValue(baseline: unknown, current: unknown, options: ResolvedOptions): ChangeNode | undefined {
  if (Array.isArray(baseline) && Array.isArray(current)) {
    return diffArray(baseline, current, options);
  }

  if (baseline instanceof Date && current instanceof Date) {
    return sameDate(baseline, current) ? undefined : modifiedChange(current, baseline);
  }

  if (baseline instanceof RegExp && current instanceof RegExp) {
    return sameRegExp(baseline, current) ? undefined : modifiedChange(current, baseline);
  }

  if (baseline instanceof Map && current instanceof Map) {
    return diffMap(baseline, current, options);
  }

  if (baseline instanceof Set && current instanceof Set) {
    return diffSet(baseline, current, options);
  }

  if (isPlainObject(baseline) && isPlainObject(current)) {
    return diffObject(baseline, current, options);
  }

  return options.isEqual(baseline, current) ? undefined : modifiedChange(current, baseline);
}

/**
 * Compares a baseline snapshot against a current value and returns only the
 * branches that actually changed — added/removed array items, modified
 * properties, modified nested objects. Returns `undefined` when nothing changed.
 *
 * See {@link DiffOptions} for known limitations around circular references,
 * `Map`/`Set`/`RegExp`, and array reordering — this covers the common case
 * (plain objects, nested objects, arrays matched by id, `Date`) rather than
 * being an exhaustive deep-diff implementation.
 */
export function diff<T>(baseline: T, current: T, options: DiffOptions = {}): ChangeSet | undefined {
  const resolved = resolveOptions(options);
  const node = diffValue(baseline, current, resolved);
  if (node === undefined) return undefined;
  return isContainerPair(baseline, current) ? (node as ChangeSet) : { root: node as ValueChange };
}

/** Whether a {@link ChangeSet} produced by {@link diff} contains any changes. */
export function hasChanges(changeSet: ChangeSet | undefined): boolean {
  return changeSet !== undefined && Object.keys(changeSet).length > 0;
}

function flattenToCurrentValue(node: ChangeNode): unknown {
  if (isValueChange(node)) {
    // A removed entry has no "current value" by definition - it's gone.
    return node.action === "removed" ? null : node.value;
  }
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(node)) {
    result[key] = flattenToCurrentValue(node[key] as ChangeNode);
  }
  return result;
}

/**
 * Reduces a {@link ChangeSet} down to just the current values — drops
 * `action` and `previousValue` everywhere, recursively. A `removed` array,
 * `Map`, or `Set` entry has no "current value" by definition, so it becomes
 * `null` rather than the deleted item's old content.
 *
 * This is a lossy convenience view for when you only need to build a plain
 * `{ field: value }` payload and don't care why a key is present — `diff()`
 * and `changes()` themselves keep the full detail; this throws part of it
 * away on purpose.
 *
 * ```ts
 * diff({ name: "A" }, { name: "B" });
 * // { name: { action: "modified", value: "B", previousValue: "A" } }
 *
 * currentValues(diff({ name: "A" }, { name: "B" }));
 * // { name: "B" }
 * ```
 */
export function currentValues(changeSet: ChangeSet | undefined): Record<string, unknown> | undefined {
  if (changeSet === undefined) return undefined;
  return flattenToCurrentValue(changeSet) as Record<string, unknown>;
}

/**
 * Clones arrays, plain objects, `Date`, `Map`, and `Set` recursively — but
 * leaves anything else (class instances, `RegExp`, functions) as the exact
 * same reference. Used to snapshot a baseline for {@link diff} without
 * silently turning class instances into plain objects, which would break
 * `instanceof` checks inside a custom {@link DiffOptions.isEqual}.
 *
 * `structuredClone` looks like the obvious tool for this, but it clones a
 * class instance into a plain object with the same fields — it does not
 * preserve the prototype. That's fine for `JSON`-shaped data; it silently
 * breaks anything that compares custom class instances by type.
 */
export function clonePreservingInstances<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => clonePreservingInstances(item)) as T;
  }
  if (value instanceof Date) {
    return new Date(value.getTime()) as T;
  }
  if (value instanceof Map) {
    return new Map(Array.from(value, ([key, entry]) => [key, clonePreservingInstances(entry)])) as T;
  }
  if (value instanceof Set) {
    return new Set(Array.from(value, (item) => clonePreservingInstances(item))) as T;
  }
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      result[key] = clonePreservingInstances(value[key]);
    }
    return result as T;
  }
  return value;
}
