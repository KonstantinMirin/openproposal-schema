# Schema conventions

These rules apply to every file in this repository. The build (`tools/build.py`) checks each rule marked **checked**.

## 1. Layers

The repository has three layers. A file references only its own layer or a lower one. **Checked.**

| Layer | Path | Holds | May reference |
|---|---|---|---|
| Kernel | `kernel/<major>/` | Primitives and composition generics | The kernel only |
| Modules | `modules/<name>/<major>/` | The types of one spec area, exported as `$defs` | The kernel, plus the modules listed in its `x-op-module.depends` |
| Documents | `documents/<major>/` | The two document roots, proposal and line item, which name the properties and type each one from a module | Everything |

- **Modules export types, never property names of a document.** A document root gives the property its name and its mutability marker. A module only says what the value looks like. A module can therefore be versioned and reused without touching the document.
- **The modules form a DAG.** Each module declares its dependencies in `x-op-module.depends`. A `$ref` to a module that isn't listed fails the build.

## 2. Primitives are defined once

Every scalar with meaning is a kernel primitive. Everything else references it by `$ref`, and no other file repeats its `type`, `pattern`, or `format`. **Checked:** outside `kernel/`, a schema containing `pattern` or `format` fails the build, unless it carries `x-op-local-pattern` with a reason.

| Primitive | File | Rule |
|---|---|---|
| `Id`, `Uuid`, `IdempotencyKey` | `kernel/1/id.json` | One identifier grammar for every ID |
| `Url`, `Uri`, `Domain` | `kernel/1/uri.json` | `Url` is `https` only |
| `CurrencyCode`, `Amount`, `Rate`, `Fraction`, `Count` | `kernel/1/number.json` | Money is an `Amount` beside a `CurrencyCode` |
| `Timestamp`, `Date`, `Duration`, `CivilTime`, `Weekday`, `TimeZone` | `kernel/1/time.json` | RFC 3339 instants; ISO 8601 durations; `HH:MM` civil time up to `24:00` |
| `Token`, `NamespacedTerm`, `Digest` | `kernel/1/term.json` | Vocabulary terms and content digests |

## 3. Lists are defined once

- **A closed list** (a state machine, a protocol switch) is an `enum` in the module that owns it, exported as a `$def`. Examples: proposal `status`, hold `state`.
- **An open vocabulary** (anything the market extends: channels, environments, cost methods, measurement providers) is `anyOf` with exactly two branches: the module's core `enum`, and `kernel/1/term.json#/$defs/NamespacedTerm` (`<domain>:<token>`). A receiver that doesn't know a namespaced term applies the receiver behavior the specification states, such as § 5.1's skip rule for an unknown `channel`. Code generators map an open vocabulary to a string with known values.
- **A list is never redeclared.** A property takes the list by `$ref`.

## 4. Unions

The keywords are restricted, so that code generators and validators agree on what a schema means.

| Keyword | Allowed for | Not allowed for |
|---|---|---|
| `oneOf` | Tagged unions only: every branch has a REQUIRED `const` discriminator property, and the union carries `x-op-discriminator` naming it | Untagged alternatives |
| `anyOf` | Open vocabularies (§ 3), and the draft-1 fallback forms (§ 3.1 and § 3.2 of the spec), marked `x-op-fallback` | Anything else |
| `allOf` | Not used | Inheritance or mixins. A document root names its properties directly |
| `if`/`then` | Conditional requirements, such as "`currency` REQUIRED when `basis` is `spend`" | Changing a property's type |

**Constraints never change types.** A code generator that ignores `if`/`then`, `not`, `minProperties`, and `maxProperties` still gets the right types. A validator gets the whole rule set. The schema is the executable form of the spec's MUSTs.

## 5. Generics

`Selectable<T>`, `Settable<T>`, and `CatalogRefOr<T>` are kernel generics written with JSON Schema 2020-12 `$dynamicRef`. A module instantiates one by `$ref`, binding the type parameter with a local `$dynamicAnchor`:

```json
"FormatSelection": {
  "$ref": "../../../kernel/1/selectable.json",
  "$defs": { "option": { "$dynamicAnchor": "option", "$ref": "#/$defs/FormatId" } }
}
```

For code generators that don't support `$dynamicRef`, `tools/build.py --flatten` expands each instantiation into a concrete schema. That keeps one source.

## 6. Mutability

The document root carries each property's marker as `x-op-mutability`, one of `immutable`, `seller-set`, `selectable`, `settable`, `supplied`, `requestable`, `derived`, and `mixed`. The marker and the value type must agree: a `selectable` property's type is a `Selectable<T>`. **Checked**, and cross-checked against Appendix A of the spec.

## 7. Extensions and overlays: proposed, not in the specification

This section is our proposal for the working group, not generated schema. The specification states no extension mechanism, so the model has no `ExtensionEntry` and no extension point, and the emitter publishes neither. They become generated schema only when the specification states them ([type rules § 12](type-rules.md#12-proposed-not-in-the-specification)).

- **The kernel defines the envelope once:** `ExtensionEntry` is `{ uri, digest, must_understand?, data }`. Its `data` is opaque to the core.
- **A module declares where an extension may attach**, with `x-op-extension-point: { name, must_understand: always | flag | never }` on an `extensions` array property it owns.
- **An extension is a separately versioned schema** that overlays the core at a declared point. It is identified by `uri`, and its exact version by the `digest` of its canonical bytes. Adding a point is a minor release of the module that owns it. Nothing else moves.
- **Validation has two passes.** Pass 1 validates the document against the core, treating each `data` as an object. Pass 2 validates each `data` against the extension that `uri` and `digest` select. A missing extension at an `always` point fails. At a `flag` point it fails only if the entry says `must_understand: true`. At a `never` point it is skipped.

## 8. Versions

- **SemVer 2.0 everywhere,** as one string format with no normalization rules.
- **The major version is in the path and the `$id`** (`kernel/1/`, `modules/pricing/1/`). Minor and patch versions are not in `$id`, so a minor release changes no reference.
- **The release manifest is the only place minor versions and digests live.** `release.json` maps each kernel, module, and document path to `{ version, digest }`, and gives the bundle digest. The build computes every digest, and nobody types one by hand.
- **Proposed, not in the specification: a document declares conformance once, at its root,** in `conforms_to: { release, digest, extensions[] }`. The specification states no conformance declaration, so the model has none and the emitter publishes none until the specification states it ([type rules § 12](type-rules.md#12-proposed-not-in-the-specification)). No other object carries a version field. A line item travels without its proposal (spec § 7), so a line item that is a document root carries `conforms_to` too. A line item inside a proposal doesn't.
- **Compatibility:** a receiver accepts any release with the same major version whose modules are each at the same major version as its own. It validates against the release the document names, not its own.

## 9. Digests

A digest is `sha256:` plus the lowercase hex SHA-256 of the RFC 8785 (JCS) canonical JSON. The same rule makes schema digests and the agreed-record digest. **Checked.**
