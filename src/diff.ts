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
 * The diff between two snapshots. Keys are either object property names or,
 * for arrays, the item's id (see {@link DiffOptions.idKey}). Only keys that
 * actually changed are present — an unchanged branch never appears here.
 */
export interface ChangeSet {
  [key: string]: ChangeNode;
}

export interface DiffOptions {
  /** Property used to match array items between the two snapshots. Default: `"id"`. */
  idKey?: string;
  /** Property names to skip everywhere, at any depth. */
  ignore?: string[];
}

interface ResolvedOptions {
  idKey: string;
  ignore: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

function sameDate(a: Date, b: Date): boolean {
  return a.getTime() === b.getTime();
}

function itemKey(item: unknown, index: number, idKey: string): string {
  if (isPlainObject(item) && item[idKey] !== undefined) {
    return String(item[idKey]);
  }
  return `#${index}`;
}

function diffArray(baseline: unknown[], current: unknown[], options: ResolvedOptions): ChangeSet | undefined {
  const before = new Map<string, unknown>();
  baseline.forEach((item, index) => before.set(itemKey(item, index, options.idKey), item));

  const after = new Map<string, unknown>();
  current.forEach((item, index) => after.set(itemKey(item, index, options.idKey), item));

  const result: ChangeSet = {};

  for (const [key, item] of after) {
    if (!before.has(key)) {
      result[key] = { action: "added", value: item };
    }
  }

  for (const [key, item] of before) {
    if (!after.has(key)) {
      result[key] = { action: "removed", value: item };
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
}

function diffObject(
  baseline: Record<string, unknown>,
  current: Record<string, unknown>,
  options: ResolvedOptions,
): ChangeSet | undefined {
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
}

function diffValue(baseline: unknown, current: unknown, options: ResolvedOptions): ChangeNode | undefined {
  if (Array.isArray(baseline) && Array.isArray(current)) {
    return diffArray(baseline, current, options);
  }

  if (baseline instanceof Date && current instanceof Date) {
    return sameDate(baseline, current) ? undefined : { action: "modified", value: current, previousValue: baseline };
  }

  if (isPlainObject(baseline) && isPlainObject(current)) {
    return diffObject(baseline, current, options);
  }

  return baseline === current ? undefined : { action: "modified", value: current, previousValue: baseline };
}

/**
 * Compares a baseline snapshot against a current value and returns only the
 * branches that actually changed — added/removed array items, modified
 * properties, modified nested objects. Returns `undefined` when nothing changed.
 */
export function diff<T>(baseline: T, current: T, options: DiffOptions = {}): ChangeSet | undefined {
  const resolved: ResolvedOptions = {
    idKey: options.idKey ?? "id",
    ignore: options.ignore ?? [],
  };

  if (Array.isArray(baseline) && Array.isArray(current)) {
    return diffArray(baseline, current, resolved);
  }

  if (isPlainObject(baseline) && isPlainObject(current)) {
    return diffObject(baseline, current, resolved);
  }

  const leaf = diffValue(baseline, current, resolved);
  return leaf === undefined ? undefined : { root: leaf };
}

/** Whether a {@link ChangeSet} produced by {@link diff} contains any changes. */
export function hasChanges(changeSet: ChangeSet | undefined): boolean {
  return changeSet !== undefined && Object.keys(changeSet).length > 0;
}
