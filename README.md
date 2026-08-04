# angular-unit-of-work

Reactive change-tracking for Angular Signals. Point it at a `WritableSignal`, get back a live
diff of what changed, an `unsavedChanges` boolean, and a one-call revert — all as plain Signals.

```ts
const draft = signal<Vessel>(vessel);
const tracker = trackChanges(draft);

draft.update(v => ({ ...v, name: "MV Renamed" }));

tracker.hasChanges();  // true
tracker.changes();     // { name: { action: "modified", value: "MV Renamed", previousValue: "MV Original" } }

tracker.revert();      // draft is back to the original vessel
tracker.commit();      // or: keep the edit, move the baseline forward
```

## Why this exists

Every non-trivial edit form eventually needs to answer three questions: *is there anything to
save*, *what exactly changed* (so you can send a minimal PATCH instead of the whole object), and
*can the user discard their edits*. Most codebases end up solving this once per form, by hand.

This package solves it once, generically, for any `WritableSignal<T>` — `T` can be a plain
object, a nested object graph, or an array of entities matched by id.

## Install

```bash
npm install angular-unit-of-work
```

Requires `@angular/core >= 17` (anything with stable Signals) as a peer dependency.

## API

### `trackChanges(source, options?)`

```ts
function trackChanges<T>(source: WritableSignal<T>, options?: DiffOptions): ChangeTracker<T>;

interface ChangeTracker<T> {
  readonly changes: Signal<ChangeSet | undefined>;
  readonly hasChanges: Signal<boolean>;
  commit(): void;   // baseline := current — call after a successful save
  revert(): void;   // current := baseline — discard in-progress edits
}

interface DiffOptions {
  idKey?: string;      // property used to match array items across snapshots. default: "id"
  ignore?: string[];   // property names to skip everywhere, at any depth
}
```

`changes` and `hasChanges` are ordinary Angular Signals. Read them in a template, feed them into
another `computed()`, or watch them with your own `effect()` — this library doesn't run any
effects of its own, so there's nothing to subscribe to and nothing to dispose.

### `diff(baseline, current, options?)`

The pure comparison function `trackChanges` is built on. No Angular import, no signals — just two
values in, a change tree out. Useful on its own for comparing two snapshots you already have
(e.g. two API responses), or in a non-Angular context.

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

This is a from-scratch implementation, not a port. Two earlier company-internal versions I'd
worked with used **polling** (`setInterval` every 100ms, wrapped in an RxJS `Observable`) or an
**`effect()`** that recomputes a diff as a side effect. Both need an injection context and a
manual `dispose()`/`ngOnDestroy()` — easy to forget, and the polling variant adds up to 100ms of
latency between an edit and the UI noticing it.

Signals already have a primitive for "recompute this when its dependencies change, and only
then": `computed()`. It needs no injection context, no explicit teardown, and no delay — the diff
is exactly one `computed()` away from being correct and reactive:

```ts
const changes = computed(() => diff(baseline(), source(), options));
```

That's most of the entire Angular adapter. The recursive diffing itself
(`src/diff.ts`) has zero Angular dependency and is tested as plain TypeScript.

One consequence of recomputing from scratch on every read, instead of patching a mutable tree
incrementally: editing a field and then editing it back to its original value produces **no
diff entry at all**, automatically — there's no special-cased "undo" logic anywhere, it falls out
of comparing two snapshots.

## License

MIT
