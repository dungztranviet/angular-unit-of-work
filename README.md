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

### `DiffOptions`

```ts
interface DiffOptions {
  idKey?: string;                                        // default: "id"
  ignore?: string[];
  arrayStrategy?: "byId" | "sequence";                   // default: "byId"
  isEqual?: (baseline: unknown, current: unknown) => boolean; // default: Object.is
}
```

- **`idKey`** — which property identifies an array item across the two snapshots.
- **`ignore`** — property names to skip everywhere, at any depth.
- **`arrayStrategy`** — `"byId"` matches items by `idKey` (fast, but a reorder with no id looks
  like every shifted item was modified). `"sequence"` aligns items by content instead — a `git
  diff`-style longest-common-subsequence match. A pure reorder that keeps items' *relative* order
  produces no diff for the untouched items; a genuinely different item is reported as one
  `removed` plus one `added` (keyed `-<baselineIndex>` / `+<currentIndex>`), never as a
  per-property change, since there's no id to say "this is the same item, edited."
- **`isEqual`** — how to compare anything that isn't an array, plain object, `Date`, `Map`,
  `Set`, or `RegExp` — in practice, class instances and primitives. Defaults to `Object.is`
  (reference equality for objects), so two different instances with identical fields are reported
  as changed unless you supply an `isEqual` that knows how to compare your class.

`Map`s and `Set`s are diffed structurally: a `Map`'s entries are matched by key
(added/removed/modified, keyed by the Map key); a `Set`'s entries by value (added/removed only —
a `Set` has no sub-properties to modify). `RegExp`s are compared by `.source` + `.flags`. Circular
references are detected and stopped at the second occurrence of the same (baseline, current) pair
— they won't crash, but nothing past that point in the cycle is compared.

### `currentValues(changeSet)` / `tracker.currentValues`

`changes()` keeps `action` and `previousValue` on purpose — that detail is what makes it useful
for an audit trail, a "review your changes" screen, or (with `arrayStrategy`) telling "moved" apart
from "added". None of that is needed if all you want is a flat payload of current values. Both the
standalone function and the tracker's own reactive signal give you that, lossily, on top of the
same `ChangeSet`:

```ts
diff({ name: "A" }, { name: "B" });
// { name: { action: "modified", value: "B", previousValue: "A" } }

currentValues(diff({ name: "A" }, { name: "B" }));
// { name: "B" }

// on a tracker:
tracker.currentValues(); // Signal<Record<string, unknown> | undefined>, mirrors tracker.changes()
```

A `removed` array/Map/Set entry has no "current value" by definition — it becomes `null`, not the
deleted item's old content:

```ts
currentValues(diff([{ id: 1, name: "one" }], []));
// { "1": null }
```

**`previousValue` is for humans and audit logs, not for trusting the client.** If you're tempted to
send it to a server for optimistic concurrency, don't — a client-supplied "old value" isn't
verified against anything and the server can just read the current value itself. Real optimistic
concurrency wants a single opaque version token (a `RowVersion`/`ETag`/timestamp) compared
server-side, not a set of business field values echoed back by the client. `previousValue` is
genuinely useful for showing *what changed* to a person, or logging it — not for deciding whether
a write is safe to apply.

**Neither `changes()` nor `currentValues()` is what you want for a full `PUT`.** Both only ever
contain the fields that actually changed — that's the entire point. If your API replaces the whole
resource instead of patching it (or needs the full object for validation, or you're intentionally
doing whole-object "last write wins" instead of a field-level merge), send the source signal itself,
not the tracker's output:

```ts
if (tracker.hasChanges()) {   // still useful: gate the request, skip a no-op call
  await api.save(form());     // the full object — read straight from the signal, bypass the tracker
  tracker.commit();
}
```

`hasChanges()`/`changes()`/`currentValues()` exist to save you from sending the whole object. If
that's exactly what you want to send, there's nothing to opt into — `form()` already has it.

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

The bundled `diff()` handles plain objects, nested objects, arrays (both by-id and by-content),
`Date`, `Map`, `Set`, `RegExp`, and circular references — see [`ROADMAP.md`](ROADMAP.md) for how
those were closed. It's still not an exhaustive deep-diff implementation:

- **Class instances other than the types above** compare by reference (`Object.is`) unless you
  supply `isEqual` — two instances with identical fields but different references are reported as
  changed by default.
- **`arrayStrategy: "sequence"`** is a straightforward O(n·m) longest-common-subsequence diff —
  fine for form-sized arrays, unmeasured (and not the right tool) for very large ones.
- **No performance tuning yet** — the whole tree is re-diffed on every `computed()` read; fine for
  typical form/edit-state sizes, not benchmarked beyond that.

If any of these matter for your data, supply your own `compare` (see above) — `trackChanges`
doesn't care how the diff is computed, only what comes back.

## License

MIT
