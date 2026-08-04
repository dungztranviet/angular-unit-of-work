# Roadmap: hardening the bundled `diff()`

Tracked here instead of as an issue list because there's no maintainer team yet — this is the
plan for the three gaps called out in [README → Known limitations](README.md#known-limitations).
Ordered by priority, not by size.

## Priority order and why

**Silently wrong beats loudly broken.** A diff that misses a real change and reports
`hasChanges() === false` is worse than one that throws, because nobody notices until data is lost.
That's why Map/Set/class-instance handling (currently: silent false negative) is fixed before the
circular-reference crash (currently: loud and immediate) — a crash gets reported by the first
person who hits it; a silent wrong answer might not.

1. **Map / Set / RegExp / class instances** — silent incorrect result. Fix first.
2. **Circular references** — loud crash, but at least it's loud. Fix second.
3. **Array reorder without an id** — documented, degrades gracefully (over-reports, doesn't
   under-report), lowest priority.

## 1. Map / Set / RegExp / class instances

**Problem:** `isPlainObject()` in `src/diff.ts` only excludes `Array` and `Date`. Anything else
with `typeof value === "object"` — a `Map`, a `Set`, a `RegExp`, a class instance with private
fields — falls into `diffObject()`, which walks `Object.keys()`. For a `Map`/`Set`, that's always
`[]` (their data lives outside enumerable own properties), so two different Maps diff as
"unchanged."

**Approach:**
- Add explicit branches in `diffValue()` for `Map`, `Set`, and `RegExp`, each with its own
  comparison:
  - `RegExp`: compare `.source` + `.flags`, leaf `ValueChange` if either differs.
  - `Map`: treat like an array diff over `[...map.entries()]`, keyed by the Map key (stringified)
    — reuse the added/removed/modified shape.
  - `Set`: treat as a Map where key === value (added/removed only, no "modified" — a Set has no
    sub-properties to change).
- For anything else non-plain (prototype isn't `Object.prototype` or `null`): stop pretending it's
  a plain object. Fall back to a leaf comparison. Two options, pick one and document it:
  - (a) reference equality (`baseline === current`) — simplest, matches how the library already
    treats unknown primitives, but flags "same content, new instance" as changed.
  - (b) let the caller register a per-type comparator (see item below) and reference-equality
    otherwise.
- Add a `registerType()` or `options.types` extension point so consumers can teach `diff()` about
  their own class instances, instead of this library trying to guess every case.

**Tests to add:** two `Map`s/`Set`s with same/different content; a `RegExp` with same/different
flags; a custom class instance compared by reference; a custom class instance via a registered
comparator.

## 2. Circular references

**Problem:** `diffObject`/`diffArray` recurse with no visited-set. `const a = {}; a.self = a;`
diffed against itself (or a similarly circular structure) recurses forever.

**Approach:**
- Thread a `seen: Map<object, Set<object>>` (or a single `WeakSet` of `[baseline, current]` pairs
  — needs a pair-keyed structure since the same object can appear at multiple paths) through
  `diffValue` → `diffObject`/`diffArray`.
- Before recursing into a pair, check whether this exact `(baseline, current)` pair is already on
  the current recursion path. If so, treat as unchanged and stop recursing into it (matches how
  `JSON.stringify` behaves — throws — except we choose not to throw, since a thrown error inside
  a `computed()` breaks the signal graph in a much less debuggable way than a documented
  "circular refs stop at the second occurrence" limitation).
- Document the chosen behavior clearly — "stops at the second occurrence, does not report changes
  deeper than that" — rather than silently doing something a consumer has to reverse-engineer.

**Tests to add:** self-referential object at the root; a circular reference two levels deep; a
circular reference inside an array item.

## 3. Array reorder without an `idKey` match

**Problem:** `itemKey()` falls back to `#${index}` when an item has no `idKey` property. Two
arrays that are the same items in a different order then diff as "every shifted index modified,"
which is technically true positionally but almost never what the caller wants to show a user.

**Approach:**
- Add an opt-in `arrayStrategy: "byId" | "sequence"` option (default stays `"byId"`, so this is
  non-breaking).
- `"sequence"` runs an LCS/Myers-style diff (the same family of algorithm `git diff` and most text
  diff tools use) treating items as opaque values compared by `previousDeepEqual`-style structural
  equality — insertions/deletions are reported as such; anything that's just moved is not reported
  as "modified."
- This is meaningfully more code than items 1–2 (a real sequence-alignment algorithm, not a
  branch in an existing function) — budget it as its own PR, not a quick patch.

**Tests to add:** reversing a 3-item array of primitives; moving one item from the front to the
back of an object array with no `id`; interleaving an actual content change with a reorder in the
same diff.

## Out of scope for now

- Performance work (the current implementation re-diffs the full tree on every `computed()` read
  — fine for typical form-sized data, unmeasured for very large arrays).
- A `Forms`-signals integration, if/when Angular ships a stable signals-based forms API.
