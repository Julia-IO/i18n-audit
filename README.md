# i18n-audit

A zero-dependency linter for internationalization hygiene. Point it at a codebase and it reports:

- **Hardcoded text** in code that translators will never see
- **Sentences built from pieces** (`t('you') + count + t('items')`) that can't be translated correctly
- **Missing or hand-rolled plurals** (`count === 1 ? 'item' : 'items'`, `file(s)`)
- **A key naming score**: how much context your string IDs give a translator
- **Translation problems**: missing keys, renamed placeholders, missing plural forms for each language

It works with **React, Vue and Svelte** (i18next, react-intl/FormatJS, vue-i18n) and **Flutter** (gen_l10n ARB files and easy_localization).

```
npx i18n-audit-cli path/to/your/project
```

You only need Node 16 or newer. There's nothing to install and nothing to configure.

## Why

Making a string translatable takes more than wrapping it in `t()`. Every user-facing string needs:

1. **A stable, meaningful ID.** `pricing.discountCta` tells a translator that "Save" means *pay less*. `save2` tells them nothing.
2. **A guaranteed fallback,** so a missing translation shows readable text instead of a raw key.
3. **One complete message,** with placeholders and plural rules instead of fragments glued together in code.

i18n-audit checks all three, in code and in your string files.

## Example output

```
KEY NAMING SCORE  91/100 (A)  14 keys, 2 with weak names

CODE

 ✖ Hardcoded UI text (1)
    src/Checkout.jsx:14  "Pay now"
    → Wrap it: t('feature.element.purpose', 'Default text').

 ✖ Sentence built from pieces (3)
    src/Checkout.jsx:9  t('cart.you', 'You have') is joined to other text
    → Use one key per complete sentence with placeholders: t('cart.summary', 'You have {count} items', { count }).

 ✖ Hand-rolled plural (2)
    src/Checkout.jsx:11  <p>{count === 1 ? 'item' : 'items'}</p>
    locales/en.json › cart.files  cart.files → "{count} file(s) selected"

SOURCE STRINGS

 ▲ Key name carries little context (2)
    locales/en.json › save2   15  save2 → "Save"  (no namespace; numbered key; key just repeats the English)

TRANSLATIONS

 ✖ Placeholder mismatch (1)
    locales [fr]  cart.remaining: source {count} vs fr {total}

 ✖ Missing plural forms for this locale (2)
    locales [pl]  cart.summary: needs few, many
```

Try it on the bundled examples: `node i18n-audit.js examples/react` or `node i18n-audit.js examples/flutter`.

## What it checks

| Area | Rule | What it finds |
|---|---|---|
| Code | `hardcoded-text` | Text in JSX/Vue/Svelte markup, or in Flutter `Text('...')` widgets |
| | `hardcoded-attr` | `placeholder`, `title`, `alt`, `aria-label`; in Flutter, `hintText:`, `tooltip:`, `semanticLabel:` |
| | `hardcoded-message` | Toasts, alerts and error messages with literal text |
| | `concat` | Translations joined with `+`, template literals, Dart interpolation or adjacent JSX |
| | `manual-plural` | `count === 1 ? … : …`, `? 's' : ''`, `item(s)` |
| | `missing-plural` | A count placeholder followed by a noun, with no plural rules |
| | `dynamic-key` | Keys built at runtime, which extraction tools can't see |
| | `no-fallback` | No inline default and no entry in the source file (or not in the template ARB) |
| | `default-drift` | Inline default differs from the source JSON |
| Source strings | `naming` | Weak keys: no namespace, element type only (`button.close`), numbered (`save2`), or just repeating the English |
| | `ambiguous` | Words like *Save*, *Close* or *Open* with a weak key and no description |
| | `fragment` | Strings that end mid-sentence or have leading/trailing spaces |
| | `positional-placeholder` | `{0}`, `%s`, `{}` instead of named placeholders |
| | `placeholder-undocumented` | ARB placeholders with no description or example |
| | `duplicate-source` | The same text under several keys. That's fine when the meanings differ, but check that your TMS doesn't merge them |
| Translations | `missing-translation` | Keys missing (or empty) in a target locale |
| | `placeholder-mismatch` | Placeholders dropped, added or renamed (`{name}` → `{nombre}`) |
| | `plural-forms` | Plural categories a language needs (CLDR), such as Polish *few* and *many* |
| | `untranslated` | Strings identical to the source |
| | `orphan-key` | Keys that no longer exist in the source |

The **key naming score** averages each key's score out of 100. A key loses points for missing context. The goal is `feature.element.purpose`, or `featureElementPurpose` in Flutter ARB files.

## Options

```
node i18n-audit.js [dir] [options]

  --source <locale>        Source locale (default: en; Flutter: read from l10n.yaml)
  --locales <dir>          Folder with locale JSON/ARB files (auto-detected otherwise)
  --require-defaults       Flag t() calls with no inline default, even if the key is in the source JSON
  --strict-plurals         Require every CLDR plural category, including ones only used for millions
  --write-baseline [file]  Save all current findings (default: <dir>/i18n-baseline.json)
  --baseline [file]        Only report findings that are not in the baseline
  --all                    Show every finding, not just the first 15 per rule
  --json                   Machine-readable output
  --html [file]            Also write a shareable HTML report (default: i18n-audit-report.html)
  --ci                     Exit with code 1 if there are errors
```

## HTML report

```
npx i18n-audit-cli . --html
```

Writes `i18n-audit-report.html`: a single self-contained file with the key naming score, a breakdown of keys by grade, the weakest keys and why, a per-language translation table, and every finding with its fix hint. It follows the reader's light/dark setting, shows only the project folder name (never your full disk path), and can be attached to a PR, uploaded as a CI artifact or shared as-is.

## Adopting it on an existing codebase

Most real projects have hundreds of existing issues. To block new ones without fixing everything first:

```
npx i18n-audit-cli . --write-baseline     # once; commit i18n-baseline.json
npx i18n-audit-cli . --baseline --ci      # in CI: fails only on NEW issues
```

Findings are matched by content, not line number, so editing a file doesn't make its old issues look new. The report also counts issues fixed since the baseline, so you can see the backlog shrink. Run without `--baseline` at any time to get the full picture.

### GitHub Actions

```yaml
- uses: actions/setup-node@v4
  with: { node-version: 20 }
- run: npx --yes i18n-audit-cli . --baseline --ci
```

## Ignoring a line

```jsx
<p>Beta</p> {/* i18n-ignore */}                 // ignore this line
// i18n-ignore                                  // on its own line: ignore the next line
{/* i18n-ignore hardcoded-text */}              // ignore only the named rule(s)
// i18n-ignore-file                             // ignore the whole file
```

Dart uses the same `// i18n-ignore` comments. JSON and ARB files can't hold comments, so use a baseline for those. The summary shows how many findings were ignored, so suppressions stay visible.

## How it works, and its limits

i18n-audit uses fast pattern matching, not a full parser. It needs no build step, plugins or configuration, and it scans a large monorepo in seconds. The trade-off is that it's a heuristic tool. Some findings will be judgment calls (a shortcut appended to a tooltip, for example), and unusual code can slip past it.

It skips tests, examples, docs, stories, generated files, logging and developer error messages. Before release it was tuned on real open-source React, Vue and Flutter apps.

**Not supported yet:** YAML, `.po`, `.strings` and Android XML string files; Flutter's older `Intl.message` setup.

Run the tests with `npm test`.

## License

MIT
