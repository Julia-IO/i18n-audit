#!/usr/bin/env node
'use strict';
/*
 * i18n-audit: a zero-dependency linter for i18n hygiene.
 *
 * Stacks:        i18next / react-intl / vue-i18n (JS/TS), Flutter gen_l10n (ARB) and easy_localization (Dart).
 *
 * Code:          hardcoded UI text, concatenated sentences, hand-rolled plurals,
 *                dynamic keys, missing fallbacks, defaults that drifted from the JSON.
 * String files:  key-naming score, ambiguous words, fragments, unnamed placeholders,
 *                counts without plural rules, identical source text under several keys.
 * Translations:  missing keys, placeholder mismatches, missing CLDR plural forms,
 *                untranslated and orphaned strings.
 */
const fs = require('fs');
const path = require('path');

const HELP = `Usage: node i18n-audit.js [dir] [options]

  dir                     Project root to scan (default: current directory)
  --source <locale>       Source locale (default: en)
  --locales <dir>         Folder holding locale JSON/ARB files (auto-detected if omitted;
                          Flutter projects are read from l10n.yaml)
  --require-defaults      Flag t() calls without an inline default, even if the key is in the source JSON
  --strict-plurals        Require every CLDR plural category, including ones only used for millions
  --write-baseline [file] Save every current finding to a baseline (default: <dir>/i18n-baseline.json)
  --baseline [file]       Compare against a baseline: known issues are listed as "existing" and
                          only new ones count as errors. Omit this flag for a full scan.
  --all                   Show every finding, not just the first ${15} per rule
  --json                  Machine-readable output
  --ci                    Exit with code 1 if any errors are found (only new ones, with --baseline)

Ignore comments (in code; JSON/ARB files cannot hold comments, so use a baseline for those):
  someCode() // i18n-ignore                       ignore this line
  // i18n-ignore                                  ignore the next line (comment on its own line)
  {/* i18n-ignore hardcoded-text */}              ignore only the named rule(s), comma-separated
  // i18n-ignore-file                             ignore the whole file
`;

// ---------- options ----------
const opt = { sourceExplicit: false, root: '.', source: 'en', locales: null, json: false, ci: false, all: false, requireDefaults: false };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--json') opt.json = true;
  else if (a === '--ci') opt.ci = true;
  else if (a === '--all') opt.all = true;
  else if (a === '--source') { opt.source = argv[++i]; opt.sourceExplicit = true; }
  else if (a === '--locales') opt.locales = path.resolve(argv[++i]);
  else if (a === '--require-defaults') opt.requireDefaults = true;
  else if (a === '--strict-plurals') opt.strictPlurals = true;
  else if (a === '--write-baseline' || a === '--baseline') {
    const file = argv[i + 1] && argv[i + 1].endsWith('.json') ? path.resolve(argv[++i]) : true;
    opt[a === '--baseline' ? 'baseline' : 'writeBaseline'] = file;
  }
  else if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0); }
  else opt.root = a;
}
const ROOT = path.resolve(opt.root);
const LIMIT = 15;

// ---------- rules ----------
const RULES = {
  'hardcoded-text':        ['error', 'Hardcoded UI text', "Wrap it: t('feature.element.purpose', 'Default text')."],
  'hardcoded-attr':        ['error', 'Hardcoded placeholder / title / alt / aria-label', 'Attributes are user-facing too, and screen readers read aria-labels aloud.'],
  'hardcoded-message':     ['error', 'Hardcoded toast / alert / error message', 'Error and status messages need keys like any other UI text.'],
  'concat':                ['error', 'Sentence built from pieces', "Use one key per complete sentence with placeholders: t('cart.summary', 'You have {count} items', { count })."],
  'manual-plural':         ['error', 'Hand-rolled plural', 'Use ICU {count, plural, ...} or i18next _one/_other keys. Many languages have 3-6 plural forms, not 2.'],
  'missing-plural':        ['warn',  'Count without plural rules', 'This string takes a count but has no plural forms.'],
  'dynamic-key':           ['warn',  'Key built at runtime', 'Extraction tools cannot see dynamic keys. Map each value to a full static key instead.'],
  'no-fallback':           ['error', 'No default and not in the source file', 'Users will see the raw key (in Flutter gen_l10n, the build fails).'],
  'missing-default':       ['warn',  'No inline default', 'Add a default, or drop --require-defaults if your source JSON is the single source of truth.'],
  'default-drift':         ['warn',  'Inline default differs from the source file', 'The two copies have drifted. Choose one source of truth.'],
  'naming':                ['warn',  'Key name carries little context', 'Use feature.element.purpose (checkoutPayButton in Flutter ARB) so the ID tells the translator what the string is for.'],
  'ambiguous':             ['warn',  'Ambiguous word, weak key, no description', 'Rename the key (pricing.discountCta, not save2) or add a description for translators.'],
  'fragment':              ['warn',  'Looks like a sentence fragment', 'Fragments usually get glued together in code. Merge them into one complete message.'],
  'positional-placeholder':['warn',  'Unnamed placeholder', 'Name it ({userName}, not {0} or %s) so translators know what it holds.'],
  'placeholder-undocumented':['info', 'Placeholder without description or example', 'Add a description or example under @key.placeholders, so translators know what it holds (a person? a team? a date?).'],
  'duplicate-source':      ['info',  'Same source text under several keys', 'Fine if the meanings differ, but make sure your TMS does not merge identical source strings (in Smartling, use variants).'],
  'missing-translation':   ['error', 'Missing translations', 'These keys will fall back to the source language.'],
  'placeholder-mismatch':  ['error', 'Placeholder mismatch', 'The translation drops, adds or renames a placeholder.'],
  'plural-forms':          ['error', 'Missing plural forms for this locale', 'Each locale needs every CLDR plural category it uses.'],
  'untranslated':          ['info',  'Identical to source', 'Can be intentional (brand names, "OK"), or the string was never translated.'],
  'orphan-key':            ['info',  'Key not in source', 'Probably left over from a deleted or renamed key.'],
};
// Dart-flavoured hints, shown when a rule's findings come from .dart / .arb files.
const DART_HINTS = {
  'hardcoded-text': 'Add a key to app_en.arb and use it: Text(AppLocalizations.of(context)!.checkoutPayButton).',
  'hardcoded-attr': 'Use a key here too: hintText: l10n.checkoutDiscountHint. Tooltips and semantic labels are read aloud.',
  'concat': 'Use one ARB message with placeholders: "cartSummary": "{count, plural, =1{You have 1 item} other{You have {count} items}}".',
  'manual-plural': 'Use an ICU plural in the ARB message and call l10n.cartItemCount(count).',
  'missing-plural': 'Wrap it in {count, plural, =1{...} other{...}} and type the placeholder as int.',
  'naming': 'Use featureElementPurpose (checkoutPayButton, pricingDiscountCta) so the getter name tells the translator what the string is for.',
  'ambiguous': 'Rename the key (pricingDiscountCta, not save2) or add "@key": { "description": ... }.',
};
const EASY_HINTS = {
  'hardcoded-text': "Add a key to assets/translations/en.json and use it: Text('checkout.payButton'.tr()).",
  'hardcoded-attr': "Use a key here too: hintText: 'checkout.discountHint'.tr(). Tooltips and semantic labels are read aloud.",
  'concat': "Use one message with named args: 'cart.summary'.tr(namedArgs: {'count': '$count'}), or .plural(count).",
  'manual-plural': "Use 'cart.items'.plural(count) with one/few/many/other entries in the JSON.",
  'missing-plural': "Turn it into a plural object { \"one\": ..., \"other\": ... } and call .plural(count).",
  'naming': 'Use feature.element.purpose so the key tells the translator what the string is for.',
  'ambiguous': 'Rename the key (pricing.discountCta, not save2) so it shows which meaning is intended.',
};
const SECTIONS = [
  ['CODE', ['hardcoded-text', 'hardcoded-attr', 'hardcoded-message', 'concat', 'manual-plural', 'missing-plural', 'dynamic-key', 'no-fallback', 'missing-default', 'default-drift']],
  ['SOURCE STRINGS', ['naming', 'ambiguous', 'fragment', 'positional-placeholder', 'placeholder-undocumented', 'duplicate-source']],
  ['TRANSLATIONS', ['missing-translation', 'placeholder-mismatch', 'plural-forms', 'untranslated', 'orphan-key']],
];

const findings = [];
const seen = new Set();
// Ignore comments, per file: { all: Set|'*' for the whole file, lines: Map<line, Set|'*'> }
const ignores = {};
let suppressed = 0;
function registerIgnores(relFile, raw) {
  if (!raw.includes('i18n-ignore')) return;
  const entry = { all: null, lines: new Map() };
  raw.split('\n').forEach((line, i) => {
    const m = /i18n-ignore(-file)?\b[:\s]*([\w-]+(?:\s*,\s*[\w-]+)*)?/.exec(line);
    if (!m) return;
    const named = (m[2] || '').split(/\s*,\s*/).filter(r => RULES[r]);
    const scope = named.length ? new Set(named) : '*';
    if (m[1]) { entry.all = scope; return; }
    const commentOnly = /^\s*(\{?\s*\/\*.*\*\/\s*\}?|\/\/.*|<!--.*-->)\s*$/.test(line);
    entry.lines.set(commentOnly ? i + 2 : i + 1, scope);
  });
  ignores[relFile] = entry;
}
function isIgnored(rule, where) {
  const m = /^(.+):(\d+)$/.exec(where);
  const entry = m ? ignores[m[1]] : null;
  if (!entry) return false;
  const hit = scope => scope && (scope === '*' || scope.has(rule));
  return hit(entry.all) || hit(entry.lines.get(+m[2]));
}

function add(rule, where, detail, extra = {}) {
  const id = `${rule}|${where}|${detail}`;
  if (seen.has(id)) return;
  seen.add(id);
  if (isIgnored(rule, where)) { suppressed++; return; }
  findings.push({ rule, severity: RULES[rule][0], where, detail, ...extra });
}

// ---------- generic helpers ----------
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', 'coverage', 'out', 'vendor', '.turbo', '.cache', 'Pods']);
const CODE_EXT = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.vue', '.svelte', '.dart']);
const GENERATED = /\.(g|freezed|gr|config|mocks)\.dart$|app_localizations\w*\.dart$|messages_\w+\.dart$|[\\/]generated[\\/]|\.min\.js$|\.d\.ts$/;
const NON_PRODUCT = /(^|[\\/])(__tests__|__mocks__|tests?|test_\w+|e2e|cypress|playwright|examples?|stories|storybook|docs|dev-docs|benchmarks?|fixtures)[\\/]|\.(test|spec|stories|e2e)\.[jt]sx?$|_test\.dart$/;
const MARKUP_EXT = new Set(['.js', '.jsx', '.tsx', '.vue', '.svelte']);
const LOCALE_RE = /^[a-z]{2,3}(?:[-_](?:[A-Za-z]{4}|[A-Za-z]{2}|\d{3}))*$/;
const LOCALE_DIR_RE = /(^|[\\/])(locales?|i18n|lang|langs|languages|translations|messages|intl)[\\/]/i;
const PLURAL_SUFFIX = /[_.](zero|one|two|few|many|other)$/;
const LETTERS = 'A-Za-z\\u00C0-\\u024F';
const PROSE = `[${LETTERS}]{2,}\\s+[${LETTERS}]{2,}`;

const rel = f => path.relative(ROOT, f) || f;
const norm = l => l.replace(/_/g, '-').toLowerCase();
const blank = s => s.replace(/[^\n]/g, ' ');
const clip = (s, n = 70) => { s = s.replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const quote = s => `"${clip(s)}"`;
const words = s => s.trim().split(/\s+/).filter(Boolean).length;
const letters = s => s.toLowerCase().replace(/[^a-zà-ɏ]/g, '');

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!IGNORE_DIRS.has(e.name)) walk(p, out); }
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function lineStarts(s) { const a = [0]; for (let i = 0; i < s.length; i++) if (s[i] === '\n') a.push(i + 1); return a; }
function lineOf(starts, idx) { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= idx) lo = mid; else hi = mid - 1; } return lo + 1; }

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, p) => p + blank(m.slice(p.length)));
}

// Returns the text inside balanced parentheses starting at `open`, plus the end index.
function balanced(src, open) {
  let depth = 0, q = null;
  for (let i = open; i < src.length && i < open + 3000; i++) {
    const c = src[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') q = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c) && --depth === 0) return { inner: src.slice(open + 1, i), end: i + 1 };
  }
  return null;
}
function splitArgs(s) {
  const out = []; let depth = 0, q = null, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') q = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) { out.push(s.slice(start, i).trim()); start = i + 1; }
  }
  out.push(s.slice(start).trim());
  return out.filter(x => x !== '');
}
function strLit(s) {
  const m = /^(['"`])((?:\\.|(?!\1)[\s\S])*)\1$/.exec(s.trim());
  return m ? m[2].replace(/\\(['"`])/g, '$1') : null;
}

// Top-level placeholder names: {name}, {{name}}, {count, plural, ...}, {0}, %s, %1$d
function placeholders(s) {
  const out = new Set(); let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '{') {
      if (depth === 0) { const m = /^\{\{?\s*([A-Za-z_][\w.]*|\d+)\s*[,}]/.exec(s.slice(i, i + 80)); if (m) out.add(m[1]); }
      depth++;
    } else if (s[i] === '}') depth = Math.max(0, depth - 1);
  }
  for (const m of s.matchAll(/%(\d+\$)?[sd@]/g)) out.add(m[0]);
  [...s.matchAll(/\{\}/g)].forEach((_, i) => out.add(`{}${i + 1}`));
  return [...out].sort();
}
const isCountVar = v => !v.startsWith('{}') && /^(count|n|num|number|total|qty|quantity)$|[a-z]Count$|_count$/.test(v);
const hasIcuPlural = s => /\{\s*\w+\s*,\s*(plural|selectordinal)\s*,/.test(s);
// Categories a translator must cover: those that real integer counts (0-1000) hit. This skips e.g. French and
// Spanish "many", which CLDR uses only for millions ("1 million de ..."). Use --strict-plurals to require all.
function pluralCategories(loc) {
  let pr;
  try { pr = new Intl.PluralRules(loc); } catch { return ['one', 'other']; }
  if (opt.strictPlurals) return pr.resolvedOptions().pluralCategories;
  const used = new Set(['other']);
  for (let n = 0; n <= 1000; n++) used.add(pr.select(n));
  return pr.resolvedOptions().pluralCategories.filter(c => used.has(c));
}

// ---------- discover files ----------
const allFiles = walk(ROOT);
const codeFiles = allFiles.filter(f => CODE_EXT.has(path.extname(f)) && !GENERATED.test(f) && !NON_PRODUCT.test(path.relative(ROOT, f)));

function localeOf(file) {
  const ext = path.extname(file);
  if (ext === '.arb') {
    try { const l = JSON.parse(fs.readFileSync(file, 'utf8'))['@@locale']; if (typeof l === 'string') return norm(l); } catch {}
    const mm = /(?:^|_)([a-z]{2,3}(?:_[A-Z][a-z]{3})?(?:_(?:[A-Z]{2}|\d{3}))?)$/.exec(path.basename(file, '.arb'));
    return mm ? norm(mm[1]) : null;
  }
  if (ext !== '.json') return null;
  const r = path.relative(opt.locales || ROOT, file);
  if (!opt.locales && !LOCALE_DIR_RE.test(r)) return null;
  for (const cand of [path.basename(file, '.json'), path.basename(path.dirname(file))]) if (LOCALE_RE.test(cand)) return norm(cand);
  return null;
}

function readStringFile(file, into) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.error(`! Could not parse ${rel(file)}: ${e.message}`); return; }
  const meta = {};
  const flat = path.extname(file) === '.arb';
  (function rec(o, prefix) {
    for (const [k, v] of Object.entries(o)) {
      if (k.startsWith('@')) { if (!k.startsWith('@@') && v && typeof v === 'object') meta[(prefix ? prefix + '.' : '') + k.slice(1)] = v; continue; }
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const msg = typeof v.message === 'string' ? v.message : typeof v.defaultMessage === 'string' ? v.defaultMessage : null;
        if (msg !== null && ('description' in v || 'placeholders' in v)) into[key] = { value: msg, desc: v.description || null, file };
        else rec(v, key);
      } else if (typeof v === 'string') into[key] = { value: v, desc: null, file, flat };
    }
  })(raw, '');
  for (const [k, m] of Object.entries(meta)) if (into[k]) { into[k].desc = into[k].desc || m.description || null; into[k].meta = m; }
}

const locales = {};
let localeFileCount = 0, arbCount = 0;
for (const f of opt.locales ? walk(opt.locales) : allFiles) {
  const loc = localeOf(f);
  if (!loc) continue;
  localeFileCount++;
  if (path.extname(f) === '.arb') arbCount++;
  readStringFile(f, (locales[loc] = locales[loc] || {}));
}
// Flutter: l10n.yaml names the template ARB (the source of truth); pubspec tells us the library.
const detected = [];
const l10nYaml = allFiles.find(f => path.basename(f) === 'l10n.yaml');
let flutterTemplate = null;
if (l10nYaml) {
  const cfg = {};
  for (const line of fs.readFileSync(l10nYaml, 'utf8').split('\n')) {
    const mm = /^([\w-]+)\s*:\s*['"]?([^'"#\n]+?)['"]?\s*(#.*)?$/.exec(line);
    if (mm) cfg[mm[1]] = mm[2].trim();
  }
  flutterTemplate = path.resolve(path.dirname(l10nYaml), cfg['arb-dir'] || 'lib/l10n', cfg['template-arb-file'] || 'app_en.arb');
  detected.push(`Flutter gen_l10n (template ${rel(flutterTemplate)})`);
}
const pubspec = allFiles.find(f => path.basename(f) === 'pubspec.yaml');
if (pubspec) {
  const p = fs.readFileSync(pubspec, 'utf8');
  if (/^\s*easy_localization\s*:/m.test(p)) detected.push('easy_localization');
  if (/^\s*intl_utils\s*:/m.test(p)) detected.push('intl_utils');
  if (!l10nYaml && /flutter_localizations/.test(p)) detected.push('Flutter (flutter_localizations)');
}

let srcLoc = norm(opt.source);
if (!opt.sourceExplicit && flutterTemplate && fs.existsSync(flutterTemplate) && locales[localeOf(flutterTemplate)]) srcLoc = localeOf(flutterTemplate);
if (!locales[srcLoc]) {
  const cands = Object.keys(locales).filter(l => l.startsWith(srcLoc + '-'));
  srcLoc = cands.find(l => l === `${srcLoc}-us`) || cands.sort((a, b) => Object.keys(locales[b]).length - Object.keys(locales[a]).length)[0] || null;
}
const SRC = srcLoc ? locales[srcLoc] : {};
const targets = Object.keys(locales).filter(l => l !== srcLoc).sort();

// A plural group is base_one/base_other (i18next) or base.one/base.other (easy_localization); it needs an "other".
function pluralBases(keys) {
  const set = new Set(keys);
  return new Set(keys.map(k => PLURAL_SUFFIX.exec(k)).filter(Boolean).map(m => m.input.slice(0, m.index))
    .filter(b => set.has(b + '_other') || set.has(b + '.other')));
}
const variantBase = (k, bases) => { const m = PLURAL_SUFFIX.exec(k); return m && bases.has(k.slice(0, m.index)) ? k.slice(0, m.index) : null; };
const pv = (T, base, c) => T[`${base}_${c}`] ?? T[`${base}.${c}`];
const srcLookup = key => SRC[key] || SRC[key + '_other'] || SRC[key + '.other'] || SRC[key + '_one'] || null;

// ---------- 1. scan code ----------
const usages = [];
const SKIP_LINE = /className|class=|style|console\.|logger\.|\bthrow\b|Error\(|\bwarn\(|\d(px|rem|em|ms)\b|\b(solid|rgba?|calc|var)\b|^\s*import\b|require\(|\bsql\b/i;
const T_RE = /(^|[^\w$.])(i18next\.t|i18n\.t|\$t|t|translate)\s*\(/g;
const TEXT_RE = /(?<![=\-])>([^<>{}]+)(?=[<{])/g;
const ATTR_RE = /(^|\s)(placeholder|title|alt|aria-label|aria-description|aria-placeholder|label|helperText|tooltip)\s*=\s*(["'])([^"'\n]*[A-Za-zÀ-ɏ]{2,}[^"'\n]*)\3/g;
const MSG_RE = new RegExp(`\\b(toast(?:\\.\\w+)?|alert|confirm|notify|message\\.(?:success|error|info|warning|warn)|\\w*[Tt]oast|set\\w*(?:Error|Message|Notice))\\s*\\(\\s*(['"\`])([^'"\`]*${PROSE}[^'"\`]*)\\2`);
const CONCAT_RES = [
  new RegExp(`(['"])[^'"\\n]*${PROSE}[^'"\\n]*\\s\\1\\s*\\+`),                       // 'You have ' + n
  new RegExp(`\\+\\s*(['"])\\s+[${LETTERS}]{2,}[^'"\\n]*\\1`),                         // n + ' items'
  new RegExp(`\`[^\`\\n]*(?:${PROSE}[^\`\\n]*\\$\\{|\\$\\{[^}]*\\}\\s*${PROSE})[^\`\\n]*\``), // `You have ${n} items`
];
const MANUAL_PLURAL_RES = [
  /\b\w*(?:count|length|total|num|qty|size)\w*\s*[!=]==?\s*1\s*\?\s*(?:['"`]|t\(|i18n|tr\()/i,
  /\b\w*(?:count|length|total|num|qty)\w*\s*>\s*1\s*\?\s*(?:['"`]|t\(|i18n|tr\()/i,
  /\?\s*(['"`])s\1\s*:\s*(['"`])\2/,
  /\?\s*(['"`])\1\s*:\s*(['"`])s\2/,
];

// Flutter / Dart
const DART_UI = /\b(Text|SelectableText|TextSpan|SnackBar|Tooltip|AlertDialog)\s*\(|\b(labelText|hintText|helperText|errorText|tooltip|semanticLabel|semanticsLabel|title|label|text|content)\s*:/;
const DART_SKIP = /^\s*(import|export|part|library)\b|\bprint\(|debugPrint\(|\blog\(|\bLog\.\w+\(|logger\.|Exception\(|Error\(|RegExp\(|Uri\.|@JsonKey|Key\(|\bthrow\b|assert\(/;
const NON_KEYS = new Set(['localeName', 'of', 'delegate', 'supportedLocales', 'localizationsDelegates', 'load', 'toString', 'hashCode', 'runtimeType', 'current']);
const TR_AFTER = /^\s*\)?\s*\.\s*(tr|plural)\s*\(/;
// Looks like words a user reads, not a route, asset path, map key or identifier.
function isUiString(s) {
  const bare = s.replace(/\$\{[^}]*\}|\$\w+/g, ' ');
  if (!new RegExp(`[${LETTERS}]{2,}`).test(bare)) return false;
  if (/^\s*https?:|^\s*\//.test(s)) return false;
  if (!/\s/.test(s.trim()) && (/[\/_.:@#]|^[a-z]+[A-Z]|^\$/.test(s) || /^[a-z0-9_]+$/.test(s) && s.includes('_'))) return false;
  return true;
}

function scanDart(src, at, relFile) {
  let m;
  const glued = (start, end, label) => {
    const b = src.slice(Math.max(0, start - 300), start).trimEnd();
    const a = src.slice(end, end + 300).trimStart();
    if (b.endsWith('+') || a.startsWith('+') || b.endsWith('${')) add('concat', at(start), `${clip(label, 50)} is joined to other text`);
  };

  // gen_l10n / intl_utils getters: AppLocalizations.of(context)!.payButton, l10n.itemsLeft(count), S.of(context).title
  if (arbCount) {
    const re = /(\b(?!Material|Cupertino|Widgets|Default)[A-Z]\w*Localizations\.of\([^()]*\)[!?]?|\bS\.of\([^()]*\)|\bS\.current|(?<![\w$])_?(?:l10n|localizations|appLocalizations))\s*\.\s*([a-z]\w*)/g;
    while ((m = re.exec(src))) {
      if (NON_KEYS.has(m[2])) continue;
      let end = m.index + m[0].length, args = '';
      const paren = /^\s*\(/.exec(src.slice(end, end + 20));
      if (paren) { const c = balanced(src, end + paren[0].length - 1); if (c) { args = c.inner; end = c.end; } }
      usages.push({ key: m[2], def: null, hasCount: /\bcount\b/i.test(args), where: at(m.index), note: ' (not in the template ARB)' });
      glued(m.index, end, src.slice(m.index, end));
    }
  }

  // easy_localization: 'key'.tr(), 'key'.plural(n), tr('key'), context.tr('key'), Text('key').tr()
  for (const [re, ki, isPlural] of [
    [/(['"])([\w.\-]+)\1\s*\.\s*(tr|plural)\s*\(/g, 2, x => x[3] === 'plural'],
    [/(?<![\w$])(tr|plural)\s*\(\s*(['"])([\w.\-]+)\2/g, 3, x => x[1] === 'plural'],
    [/\bText\s*\(\s*(['"])([\w.\-]+)\1\s*\)\s*\.\s*(tr|plural)\s*\(/g, 2, x => x[3] === 'plural'],
  ]) {
    while ((m = re.exec(src))) {
      const open = src.indexOf('(', m.index + m[0].length - 1);
      const c = balanced(src, open);
      usages.push({ key: m[ki], def: null, hasCount: isPlural(m), where: at(m.index) });
      const end = c ? c.end : m.index + m[0].length;
      glued(m.index, end, src.slice(m.index, end));
    }
  }

  // hardcoded widget text and named parameters
  const reText = /\b(Text|SelectableText|AutoSizeText)\s*\(\s*r?(['"])((?:\\.|(?!\2)[^\n])*)\2/g;
  while ((m = reText.exec(src))) {
    if (TR_AFTER.test(src.slice(m.index + m[0].length, m.index + m[0].length + 40)) || !isUiString(m[3])) continue;
    add('hardcoded-text', at(m.index), `${m[1]}(${quote(m[3])})`);
  }
  const reNamed = /\b(labelText|hintText|helperText|errorText|counterText|prefixText|suffixText|tooltip|semanticLabel|semanticsLabel|message|title|label|text)\s*:\s*r?(['"])((?:\\.|(?!\2)[^\n])*)\2/g;
  while ((m = reNamed.exec(src))) {
    if (TR_AFTER.test(src.slice(m.index + m[0].length, m.index + m[0].length + 40)) || !isUiString(m[3])) continue;
    add('hardcoded-attr', at(m.index), `${m[1]}: ${quote(m[3])}`);
  }

  // line-level: messages, hand-rolled plurals, concatenation and interpolation
  src.split('\n').forEach((line, i) => {
    if (DART_SKIP.test(line)) return;
    const where = `${relFile}:${i + 1}`;
    if ((m = MSG_RE.exec(line))) add('hardcoded-message', where, `${m[1]}(${quote(m[3])})`);
    if (MANUAL_PLURAL_RES.some(re => re.test(line))) add('manual-plural', where, clip(line));
    if (CONCAT_RES[0].test(line) || CONCAT_RES[1].test(line)) add('concat', where, clip(line));
    for (const lit of line.matchAll(/(['"])((?:\\.|(?!\1).)*)\1/g)) {
      const v = lit[2];
      if (DART_UI.test(line) && /\$\{?[A-Za-z_]/.test(v) && /\s/.test(v.trim()) && isUiString(v)) add('concat', where, `"${clip(v, 50)}" interpolates values into hardcoded text`);
    }
  });
}

for (const file of codeFiles) {
  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch { continue; }
  registerIgnores(rel(file), src);
  if (ignores[rel(file)] && ignores[rel(file)].all === '*') continue;
  if (src.length > 1_000_000 || /generated|do not edit|emscripten/i.test(src.slice(0, 600))) continue;
  const ext = path.extname(file);
  src = stripComments(src);
  if (ext === '.vue' || ext === '.svelte') src = src.replace(/<style[\s\S]*?<\/style>/g, blank);
  const starts = lineStarts(src);
  const at = i => `${rel(file)}:${lineOf(starts, i)}`;
  const markup = MARKUP_EXT.has(ext);
  let m;
  if (ext === '.dart') { scanDart(src, at, rel(file)); continue; }

  // translation calls
  T_RE.lastIndex = 0;
  while ((m = T_RE.exec(src))) {
    const callStart = m.index + m[1].length;
    const call = balanced(src, m.index + m[0].length - 1);
    if (!call) continue;
    const args = splitArgs(call.inner);
    if (!args.length) continue;
    const key = strLit(args[0]);
    if (key === null || key.includes('${')) {
      if (/^[`\w]|\+/.test(args[0]) && !/^\d/.test(args[0])) add('dynamic-key', at(callStart), clip(src.slice(callStart, call.end)));
      continue;
    }
    let def = args[1] ? strLit(args[1]) : null;
    if (def === null && args[1]) { const d = /defaultValue\s*:\s*(['"`])((?:\\.|(?!\1).)*)\1/.exec(args[1]); if (d) def = d[2]; }
    if (args[1] && args[1].startsWith('`') && args[1].includes('${')) add('concat', at(callStart), `default is a template literal: ${clip(args[1])}`);
    usages.push({ key: key.replace(/^[\w-]+:/, ''), def, hasCount: args.slice(1).some(a => /\bcount\b/.test(a)), where: at(callStart) });

    // glued to other pieces?
    const b = src.slice(Math.max(0, callStart - 300), callStart).trimEnd();
    const a = src.slice(call.end, call.end + 300).trimStart();
    let glued = b.endsWith('+') || a.startsWith('+') || b.endsWith('${');
    if (!glued && markup && b.endsWith('{') && a.startsWith('}')) {
      const pre = b.slice(0, -1), post = a.slice(1);
      const preLine = pre.slice(pre.lastIndexOf('\n') + 1).trimEnd();
      const nl = post.indexOf('\n');
      const postLine = (nl < 0 ? post : post.slice(0, nl)).trimStart();
      glued = preLine.endsWith('}') || postLine.startsWith('{') ||
        new RegExp(`>[^<>{}]*[${LETTERS}]{2,}[^<>{}]*$`).test(preLine) ||
        new RegExp(`^[^<>{}]*[${LETTERS}]{2,}[^<>{}]*<`).test(postLine);
    }
    if (glued) add('concat', at(callStart), `${clip(src.slice(callStart, call.end), 50)} is joined to other text`);
  }

  // FormatJS
  for (const re of [/<FormattedMessage\b([^>]*)>/g, /formatMessage\(\s*\{([^}]*)\}/g]) {
    while ((m = re.exec(src))) {
      const id = /\bid\s*[=:]\s*\{?\s*(['"])(.*?)\1/.exec(m[1]);
      const dm = /\bdefaultMessage\s*[=:]\s*\{?\s*(['"`])((?:\\.|(?!\1).)*)\1/.exec(m[1]);
      if (id) usages.push({ key: id[2], def: dm ? dm[2] : null, hasCount: /\bcount\b/.test(m[1]), where: at(m.index) });
    }
  }

  // hardcoded text and attributes in markup
  if (markup) {
    const s2 = src.replace(/<Trans\b[\s\S]*?<\/Trans>|<style\b[\s\S]*?<\/style>/g, blank);
    TEXT_RE.lastIndex = 0;
    while ((m = TEXT_RE.exec(s2))) {
      const text = m[1];
      if (!new RegExp(`[${LETTERS}]{2,}`).test(text)) continue;
      if (/[;=()]|&&|\|\||\s\?\s|^\s*(extends|implements|as|in|of|keyof|typeof)\b/.test(text)) continue;
      if (/^\s*(&[#\w]+;\s*)+$/.test(text)) continue;
      if (/^\s*[,;)\]&|]|\w\s*:\s*$|(^|\s)[.#][a-z][\w-]*/.test(text)) continue;
      const lineBefore = s2.slice(s2.lastIndexOf('\n', m.index) + 1, m.index);
      if (['"', "'", '`'].some(q => (lineBefore.split(q).length - 1) % 2 === 1)) continue;
      add('hardcoded-text', at(m.index + 1 + text.length - text.trimStart().length), quote(text));
    }
    ATTR_RE.lastIndex = 0;
    while ((m = ATTR_RE.exec(s2))) add('hardcoded-attr', at(m.index + m[1].length), `${m[2]}="${clip(m[4], 50)}"`);
  }

  // line-level patterns
  const lines = src.split('\n');
  let devContext = false;
  lines.forEach((line, i) => {
    const where = `${rel(file)}:${i + 1}`;
    const prevDev = devContext;
    devContext = SKIP_LINE.test(line) || (prevDev && !/[;{}]\s*$/.test(line));
    if (prevDev && /^\s*[`'"+]/.test(line)) return;
    if ((m = MSG_RE.exec(line))) add('hardcoded-message', where, `${m[1]}(${quote(m[3])})`);
    if (MANUAL_PLURAL_RES.some(re => re.test(line))) add('manual-plural', where, clip(line));
    if (!SKIP_LINE.test(line) && CONCAT_RES.some(re => re.test(line))) add('concat', where, clip(line));
  });
}

// ---------- 2. source strings (source JSON + inline defaults not yet extracted) ----------
const S = {};
for (const [k, e] of Object.entries(SRC)) S[k] = { value: e.value, desc: e.desc, flat: e.flat, meta: e.meta, where: `${rel(e.file)} › ${k}` };
for (const u of usages) if (u.def !== null && !srcLookup(u.key) && !S[u.key]) S[u.key] = { value: u.def, desc: null, where: u.where };
const sPluralBases = pluralBases(Object.keys(S));
const pluralReady = key => sPluralBases.has(key) || (S[key] && hasIcuPlural(S[key].value));

// code checks that need the source strings
for (const u of usages) {
  const se = srcLookup(u.key);
  if (u.def === null && !se) add('no-fallback', u.where, u.key + (srcLoc ? u.note || '' : ''));
  else if (u.def === null && opt.requireDefaults) add('missing-default', u.where, u.key);
  else if (u.def !== null && se && SRC[u.key] && se.value !== u.def) add('default-drift', u.where, `${u.key}: code "${clip(u.def, 40)}" vs ${srcLoc}.json "${clip(se.value, 40)}"`);
  const sv = S[u.key], svPh = (sv && sv.meta && sv.meta.placeholders) || {};
  const valueHasCount = sv && placeholders(sv.value).some(p => isCountVar(p) || ['int', 'num'].includes(svPh[p] && svPh[p].type));
  if (u.hasCount && !pluralReady(u.key) && !(u.def && hasIcuPlural(u.def)) && !valueHasCount) add('missing-plural', u.where, `${u.key} is called with a count`);
}

const GENERIC_ROOT = new Set(['button', 'buttons', 'btn', 'label', 'labels', 'text', 'texts', 'string', 'strings', 'common', 'general', 'misc', 'global', 'globals', 'msg', 'messages', 'link', 'links', 'title', 'titles', 'shared']);
const MEANINGLESS = /^((text|txt|string|str|label|lbl|msg|item|key|value|val|field|tmp|temp|test|foo|bar|untitled)\d*|stuff|misc|new|other)$/i;
const AMBIGUOUS = new Set('close open save clear light free order book post charge match present record live last back check content fine share set change balance bill block draft file filter flag follow like mark note pass print rate rest return review right sign state store subject tag top track watch view display contact report'.split(' '));

function nameIssues(key, value, flat) {
  const k = key.replace(/^[\w-]+:/, '');
  const camel = flat && !k.includes('.');            // Flutter ARB: checkoutPayButton
  const segs = camel ? k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s_]+/) : k.split('.');
  const last = camel ? k : segs[segs.length - 1];
  const issues = [];
  if (segs.length < 2) issues.push([camel ? 'single word, no feature' : 'no namespace', 35]);
  else if (segs.slice(0, -1).every(s => GENERIC_ROOT.has(s.toLowerCase()))) issues.push(['element type only, no feature', 25]);
  if ((camel ? [k] : segs).some(s => MEANINGLESS.test(s))) issues.push(['meaningless name', 30]);
  else {
    const num = segs.map(s => /[A-Za-z](\d+)$/.exec(s)).find(Boolean);
    if (num && words(value) <= 3 && !value.includes(num[1])) issues.push(['numbered key', 20]);
  }
  const noContext = camel || segs.length < 2 || segs.slice(0, -1).every(s => GENERIC_ROOT.has(s.toLowerCase()));
  if (noContext && words(value) <= 4 && letters(last) && letters(last) === letters(value)) issues.push(['key just repeats the English', 25]);
  return issues;
}

const scores = [];
const byValue = new Map();
for (const [key, e] of Object.entries(S)) {
  const base = variantBase(key, sPluralBases) || key;
  const isVariant = base !== key;
  const v = e.value;

  if (!isVariant || /[_.]other$/.test(key)) {
    const issues = nameIssues(base, v, e.flat);
    const score = Math.max(0, 100 - issues.reduce((t, [, p]) => t + p, 0));
    scores.push(score);
    if (issues.length) add('naming', e.where, `${String(score).padStart(3)}  ${base} → ${quote(v)}  (${issues.map(i => i[0]).join('; ')})`, { score });
    const word = v.trim().replace(/[.!?:…]+$/, '').toLowerCase();
    if (AMBIGUOUS.has(word) && !e.desc && issues.length) add('ambiguous', e.where, `${base} → ${quote(v)}`);
    if (words(v) <= 3 && !isVariant) {
      const nv = v.trim().toLowerCase();
      byValue.set(nv, [...(byValue.get(nv) || []), base]);
    }
  }

  if (/^\s|\s$/.test(v) && v.trim()) add('fragment', e.where, `${key} → "${v}" (leading/trailing space)`);
  else if (/\b(of|to|and|or|the|a|an|have|has|with|for|by|your|my|than|from)$/i.test(v.trim()) && words(v) > 1) add('fragment', e.where, `${key} → ${quote(v)} (ends mid-sentence)`);

  if (isVariant ? /\{\d+\}|%(?:\d+\$)?[sd@]/.test(v) : /\{\d*\}|%(?:\d+\$)?[sd@]/.test(v)) add('positional-placeholder', e.where, `${key} → ${quote(v)}`);
  if (/\w\((?:s|es)\)/i.test(v)) add('manual-plural', e.where, `${key} → ${quote(v)}`);
  const phMeta = (e.meta && e.meta.placeholders) || {};
  const isCount = p => isCountVar(p) || ['int', 'num'].includes(phMeta[p] && phMeta[p].type);
  const countedNoun = p => new RegExp(`\\{\\{?\\s*${p.replace(/[.$]/g, '\\$&')}\\s*\\}?\\}\\s+[${LETTERS}]`).test(v);
  if (!isVariant && placeholders(v).some(p => isCount(p) && countedNoun(p)) && !hasIcuPlural(v) && !sPluralBases.has(key)) add('missing-plural', e.where, `${key} → ${quote(v)}`);
  if (e.flat) {
    const undocumented = placeholders(v).filter(p => !isCount(p) && !/^%|^\d/.test(p) && !(phMeta[p] && (phMeta[p].description || phMeta[p].example)));
    if (undocumented.length) add('placeholder-undocumented', e.where, `${key} → ${quote(v)}  ({${undocumented.join('}, {')}})`);
  }
}
for (const [v, keys] of byValue) if (keys.length > 1) add('duplicate-source', `"${v}"`, keys.join(', '));

// ---------- 3. translations ----------
const srcPluralBases = pluralBases(Object.keys(SRC));
for (const loc of targets) {
  const T = locales[loc];
  const anyFile = Object.values(T)[0];
  const where = anyFile ? rel(path.dirname(anyFile.file)) + ` [${loc}]` : loc;
  const missing = [], untranslated = [], orphans = [];
  const sameLang = loc.split('-')[0] === (srcLoc || '').split('-')[0];

  for (const [k, e] of Object.entries(SRC)) {
    if (variantBase(k, srcPluralBases)) continue;
    const t = T[k];
    if (t === undefined || (t.value.trim() === '' && e.value.trim() !== '')) { missing.push(k); continue; }
    const show = ps => ps.length ? ps.map(p => p.startsWith('{}') ? '{}' : p.startsWith('%') ? p : `{${p}}`).join(' ') : '(none)';
    const ps = placeholders(e.value), pt = placeholders(t.value);
    if (ps.join() !== pt.join()) add('placeholder-mismatch', where, `${k}: source ${show(ps)} vs ${loc} ${show(pt)}`);
    if (hasIcuPlural(e.value)) {
      if (!hasIcuPlural(t.value)) add('plural-forms', where, `${k}: translation dropped the plural`);
      else {
        const have = new Set([...t.value.matchAll(/(?:^|[\s,}])(zero|one|two|few|many|other|=\d+)\s*\{/g)].map(x => x[1] === '=1' ? 'one' : x[1] === '=0' ? 'zero' : x[1]));
        const lack = pluralCategories(loc).filter(c => !have.has(c));
        if (lack.length) add('plural-forms', where, `${k}: needs ${lack.join(', ')}`);
      }
    }
    const bare = e.value.replace(/\{[^{}]*\}|%\S/g, '').trim();
    if (!sameLang && t.value === e.value && bare.length > 3 && !/^[A-Z0-9 .\-]+$/.test(bare) && new RegExp(`[${LETTERS}]{3,}`).test(bare)) untranslated.push(k);
  }

  for (const base of srcPluralBases) {
    const cats = pluralCategories(loc);
    const present = cats.filter(c => pv(T, base, c) !== undefined);
    if (!present.length && T[base] === undefined) { missing.push(base); continue; }
    const lack = cats.filter(c => pv(T, base, c) === undefined);
    if (lack.length) add('plural-forms', where, `${base}: needs ${lack.join(', ')}`);
    const allowed = new Set(Object.keys(SRC).filter(k => variantBase(k, srcPluralBases) === base).flatMap(k => placeholders(SRC[k].value)));
    for (const c of present) {
      const extra = placeholders(pv(T, base, c).value).filter(p => !allowed.has(p) && !p.startsWith('{}'));
      if (extra.length) add('placeholder-mismatch', where, `${base}_${c}: unknown placeholder {${extra.join(', ')}}`);
    }
  }

  if (missing.length) add('missing-translation', where, `${missing.length} key(s): ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ', …' : ''}`, { keys: missing });
  for (const k of Object.keys(T)) {
    const m = PLURAL_SUFFIX.exec(k);
    if (!SRC[k] && !(m && srcPluralBases.has(k.slice(0, m.index))) && !srcPluralBases.has(k)) orphans.push(k);
  }
  const list = ks => `${ks.length} key(s): ${ks.slice(0, 6).join(', ')}${ks.length > 6 ? ', …' : ''}`;
  if (untranslated.length) add('untranslated', where, list(untranslated), { keys: untranslated });
  if (orphans.length) add('orphan-key', where, list(orphans), { keys: orphans });
}

// ---------- report ----------
const namingScore = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
const grade = s => s >= 90 ? 'A' : s >= 75 ? 'B' : s >= 60 ? 'C' : s >= 40 ? 'D' : 'F';
// Baseline: findings are identified by rule + file + detail (no line number, so edits elsewhere in a file
// don't make old issues look new). Findings that list keys are matched key by key.
const baselineId = f => `${f.rule}|${f.where.replace(/:\d+$/, '')}|${f.detail}`;
const keyIds = f => f.keys.map(k => `${f.rule}|${f.where}|key:${k}`);
const keyList = ks => `${ks.length} key(s): ${ks.slice(0, 6).join(', ')}${ks.length > 6 ? ', …' : ''}`;
const defaultBaseline = path.join(ROOT, 'i18n-baseline.json');

if (opt.writeBaseline) {
  const entries = {};
  for (const f of findings) for (const id of f.keys ? keyIds(f) : [baselineId(f)]) entries[id] = (entries[id] || 0) + 1;
  const file = opt.writeBaseline === true ? defaultBaseline : opt.writeBaseline;
  const sorted = Object.fromEntries(Object.entries(entries).sort(([a], [b]) => (a < b ? -1 : 1)));
  fs.writeFileSync(file, JSON.stringify({ tool: 'i18n-audit', version: 1, created: new Date().toISOString().slice(0, 10), findings: findings.length, entries: sorted }, null, 2) + '\n');
  if (!opt.json) console.error(`Baseline written: ${path.relative(process.cwd(), file) || file} (${findings.length} findings). Commit it, then run with --baseline.`);
}

let baselineInfo = null;
if (opt.baseline) {
  const file = opt.baseline === true ? defaultBaseline : opt.baseline;
  let b;
  try { b = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.error(`Could not read baseline ${file}: ${e.message}`); process.exit(2); }
  const left = { ...(b.entries || {}) };
  const take = id => (left[id] > 0 ? (left[id]--, true) : false);
  for (const f of findings) {
    if (f.keys) {
      const ids = keyIds(f);
      const fresh = f.keys.filter((k, i) => !take(ids[i]));
      const known = f.keys.length - fresh.length;
      if (!fresh.length) f.baseline = true;
      else if (known) { f.keys = fresh; f.detail = `${keyList(fresh)}  (+${known} in baseline)`; }
    } else if (take(baselineId(f))) f.baseline = true;
  }
  baselineInfo = {
    file: path.relative(process.cwd(), file) || file,
    existing: findings.filter(f => f.baseline).length,
    fixed: Object.values(left).reduce((a, n) => a + n, 0),
  };
}

const active = findings.filter(f => !f.baseline);
const count = sev => active.filter(f => f.severity === sev).length;
const summary = { errors: count('error'), warnings: count('warn'), info: count('info'), suppressedByComments: suppressed,
  ...(baselineInfo ? { existingInBaseline: baselineInfo.existing, fixedSinceBaseline: baselineInfo.fixed } : {}) };

if (opt.json) {
  console.log(JSON.stringify({ root: ROOT, detected, sourceLocale: srcLoc, targetLocales: targets, codeFiles: codeFiles.length, localeFiles: localeFileCount,
    naming: { score: namingScore, grade: namingScore === null ? null : grade(namingScore), keys: scores.length }, summary,
    baseline: baselineInfo, findings: findings.map(f => ({ ...f, baseline: !!f.baseline })) }, null, 2));
} else {
  const tty = process.stdout.isTTY && !process.env.NO_COLOR;
  const c = (code, s) => tty ? `\x1b[${code}m${s}\x1b[0m` : s;
  const bold = s => c(1, s), dim = s => c(2, s), red = s => c(31, s), yellow = s => c(33, s), blue = s => c(36, s), green = s => c(32, s);
  const icon = sev => sev === 'error' ? red('✖') : sev === 'warn' ? yellow('▲') : blue('●');

  console.log(`\n${bold('i18n-audit')}  ${dim(ROOT)}`);
  console.log(`Scanned ${codeFiles.length} code file(s) and ${localeFileCount} locale file(s)` +
    (srcLoc ? `. Source: ${srcLoc}${targets.length ? `. Targets: ${targets.join(', ')}` : ''}` : ''));
  if (detected.length) console.log(`Detected: ${detected.join(', ')}`);
  if (!srcLoc) console.log(yellow(`No ${opt.source} locale files found. Point to them with --locales <dir>.`));
  if (baselineInfo) {
    console.log(`Baseline: ${baselineInfo.file}. ${bold(String(active.length))} new finding(s) shown, ${baselineInfo.existing} existing hidden` +
      (baselineInfo.fixed ? `, ${green(`${baselineInfo.fixed} fixed since the baseline`)} (run --write-baseline to lock that in)` : '') + '.');
  }

  if (namingScore !== null) {
    const col = namingScore >= 75 ? green : namingScore >= 60 ? yellow : red;
    const weak = findings.filter(f => f.rule === 'naming').length;
    console.log(`\n${bold('KEY NAMING SCORE')}  ${col(bold(`${namingScore}/100 (${grade(namingScore)})`))}  ${dim(`${scores.length} keys, ${weak} with weak names`)}`);
  }

  for (const [title, rules] of SECTIONS) {
    const inSection = active.filter(f => rules.includes(f.rule));
    if (!inSection.length) continue;
    console.log(`\n${bold(title)}`);
    for (const rule of rules) {
      let list = inSection.filter(f => f.rule === rule);
      if (!list.length) continue;
      if (rule === 'naming') list = list.sort((x, y) => x.score - y.score);
      const [sev, name, hint] = RULES[rule];
      const old = baselineInfo ? findings.filter(f => f.baseline && f.rule === rule).length : 0;
      console.log(`\n ${icon(sev)} ${bold(name)} ${dim(`(${list.length}${old ? ` new, ${old} in baseline` : ''})`)}`);
      for (const f of opt.all ? list : list.slice(0, LIMIT)) console.log(`    ${dim(f.where)}  ${f.detail}`);
      if (!opt.all && list.length > LIMIT) console.log(dim(`    … ${list.length - LIMIT} more (use --all)`));
      const isDart = f => /\.(dart|arb)\b/.test(f.where) || (!arbCount && detected.includes('easy_localization'));
      const dartHints = !arbCount && detected.includes('easy_localization') ? EASY_HINTS : DART_HINTS;
      if (dartHints[rule] && list.some(isDart)) {
        if (!list.every(isDart)) console.log(dim(`    → ${hint}`));
        console.log(dim(`    → ${list.every(isDart) ? '' : 'Flutter: '}${dartHints[rule]}`));
      } else console.log(dim(`    → ${hint}`));
    }
  }
  if (!active.length) console.log(green(`\n✔ No ${baselineInfo ? 'new ' : ''}findings.`));
  const extra = [suppressed ? `${suppressed} ignored by i18n-ignore comments` : '', baselineInfo ? `${baselineInfo.existing} in baseline` : ''].filter(Boolean).join(', ');
  console.log(`\n${red(`${summary.errors} errors`)}, ${yellow(`${summary.warnings} warnings`)}, ${blue(`${summary.info} info`)}${baselineInfo ? ' (new)' : ''}${extra ? dim(`  ·  ${extra}`) : ''}\n`);
}
process.exit(opt.ci && summary.errors ? 1 : 0);
