# angular-unit-of-work

**The Angular Signals adapter for change-tracking** — not a new diffing algorithm. Point it at a
`WritableSignal`, get back a live diff of what changed, an `unsavedChanges` boolean, and a
one-call revert, all as plain Signals kept in sync via `computed()`.

```ts
const draft = signal<Vessel>(vessel);
const tracker = trackChanges(draft);

draft.update(v => ({ ...v, name: "MV Renamed" }));

tracker.hasChanges();  // true
tracker.changes();     // { name: { action: "modified", value: "MV Renamed", previousValue: "MV Original" } }

tracker.revert();      // draft is back to the original vessel
tracker.commit();      // or: keep the edit, move the baseline forward
```

## What this is (and isn't)

**This is not a diffing library competing with `microdiff`, `fast-json-patch`, or
`jsondiffpatch`.** Those are more mature, more battle-tested at deep-diffing arbitrary JS values
than the small comparison function bundled here. What none of them give you is a *reactive*
result — you'd still have to wire "re-run the diff when the signal changes" and "expose that as
something a template can read" yourself.

That's the actual job of this package: turning a `WritableSignal<T>` plus *any* diffing function
into a `ChangeTracker<T>` — a `changes`/`hasChanges` pair that's always correct because it's
`computed()`, not cached or manually invalidated, plus `commit()`/`revert()` for the baseline. A
small `diff()` is bundled as a working default for the common case (plain objects, nested
objects, arrays matched by id, `Date`), but you can swap it for a more capable one — see
[`compare`](#trackchangessource-options) below. See [Known limitations](#known-limitations) for
what the bundled default doesn't handle yet.

## Why this exists

Every non-trivial edit form eventually needs to answer three questions: *is there anything to
save*, *what exactly changed* (so you can send a minimal PATCH instead of the whole object), and
*can the user discard their edits*. Most codebases end up solving this once per form, by hand —
usually by hand-rolling the reactive plumbing around whatever diff they already have.

## Install

```bash
npm install angular-unit-of-work
```

Requires `@angular/core >= 17` (anything with stable Signals) as a peer dependency.

## API

### `trackChanges(source, options?)`

```ts
function trackChanges<T>(source: WritableSignal<T>, options?: TrackChangesOptions<T>): ChangeTracker<T>;

interface ChangeTracker<T> {
  readonly changes: Signal<ChangeSet | undefined>;
  readonly hasChanges: Signal<boolean>;
  commit(): void;   // baseline := current — call after a successful save
  revert(): void;   // current := baseline — discard in-progress edits
}

interface TrackChangesOptions<T> extends DiffOptions {
  idKey?: string;      // property used to match array items across snapshots. default: "id"
  ignore?: string[];   // property names to skip everywhere, at any depth
  compare?: (baseline: T, current: T, options: DiffOptions) => ChangeSet | undefined;
}
```

`changes` and `hasChanges` are ordinary Angular Signals. Read them in a template, feed them into
another `computed()`, or watch them with your own `effect()` — this library doesn't run any
effects of its own, so there's nothing to subscribe to and nothing to dispose.

`trackChanges` doesn't know or care how the diff is computed — it calls whatever `compare`
resolves to (the bundled `diff` by default) with `(baseline, current, options)` and turns the
result into Signals. Swap in your own comparator, or a wrapper around a more capable library,
without losing `hasChanges`/`commit`/`revert`:

```ts
import { compare as jsonPatchCompare } from "some-json-patch-lib"; // illustrative

const tracker = trackChanges(draft, {
  compare: (baseline, current) => jsonPatchCompare(baseline, current),
});
```

### `diff(baseline, current, options?)`

The bundled comparison function — the default for `compare` above, and usable standalone. No
Angular import, no signals — just two values in, a change tree out. Useful on its own for
comparing two snapshots you already have (e.g. two API responses), or in a non-Angular context.

```ts
diff({ name: "A" }, { name: "B" });
// { name: { action: "modified", value: "B", previousValue: "A" } }

diff([{ id: 1, name: "one" }], [{ id: 1, name: "one" }, { id: 2, name: "two" }]);
// { "2": { action: "added", value: { id: 2, name: "two" } } }
```

### The `ChangeSet` shape

A `ChangeSet` is a plain object tree. Every key that didn't change is simply absent — there is no
"unchanged" marker to filter out.

- **Object property changed** → `{ action: "modified", value, previousValue }`
- **Array item added** → keyed by its id (or index, if no id): `{ action: "added", value }`
- **Array item removed** → same, `{ action: "removed", value }`
- **Array item's own property changed** → the same recursive shape, keyed by the item's id
- **Nested object changed** → a nested `ChangeSet`, not a leaf — you get the sub-diff, not the
  whole replaced object

```ts
// tracking a signal of { name, vessel: { name }, deficiencies: Deficiency[] }
{
  name: { action: "modified", value: "...", previousValue: "..." },
  vessel: {
    name: { action: "modified", value: "...", previousValue: "..." }
  },
  deficiencies: {
    "guid-1": { action: "added", value: { ... } },
    "id-42":  { action: "removed", value: { ... } },
    "id-17":  { description: { action: "modified", value: "...", previousValue: "..." } }
  }
}
```

## Design notes

The adapter is a from-scratch implementation, not a port. Two earlier company-internal versions
I'd worked with used **polling** (`setInterval` every 100ms, wrapped in an RxJS `Observable`) or
an **`effect()`** that recomputes a diff as a side effect. Both need an injection context and a
manual `dispose()`/`ngOnDestroy()` — easy to forget, and the polling variant adds up to 100ms of
latency between an edit and the UI noticing it.

Signals already have a primitive for "recompute this when its dependencies change, and only
then": `computed()`. It needs no injection context, no explicit teardown, and no delay:

```ts
const changes = computed(() => compare(baseline(), source(), options));
```

That's essentially the entire adapter — `trackChanges` is a thin wrapper around one `computed()`
plus a baseline `signal()`. The comparison logic behind it is a separate, swappable concern (see
[What this is (and isn't)](#what-this-is-and-isnt)).

One consequence of recomputing from scratch on every read, instead of patching a mutable tree
incrementally: editing a field and then editing it back to its original value produces **no
diff entry at all**, automatically — there's no special-cased "undo" logic anywhere, it falls out
of comparing two snapshots. This holds regardless of which `compare` function you use, since it's
a property of the `computed()` plumbing, not of the bundled `diff()`.

## Known limitations

The bundled `diff()` covers the common case — plain objects, nested objects, arrays matched by
id, `Date` — but it is deliberately small, not exhaustive. As of now it does **not** handle:

- **Circular references** — will recurse until the call stack overflows.
- **`Map` / `Set` / `RegExp` / class instances other than `Date`** — treated as a plain object,
  which for these types silently reports "no changes" even when the content differs.
- **Reordering an array with no `idKey` match** — falls back to comparing by index, so a pure
  reorder looks like every shifted item was modified.

If any of these matter for your data, either supply your own `compare` (see above) or track the
plan to fix them in [`ROADMAP.md`](ROADMAP.md).

## License

MIT
