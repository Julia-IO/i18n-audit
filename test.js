#!/usr/bin/env node
// Smoke test: runs i18n-audit on the bundled examples and checks that the planted issues are found.
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLI = path.join(__dirname, 'i18n-audit.js');
const run = (...args) => {
  try { return execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }); }
  catch (e) { return e.stdout; } // --ci exits 1 when there are errors
};
const audit = dir => JSON.parse(run(path.join(__dirname, 'examples', dir), '--json'));

let failed = 0;
function expect(label, ok) {
  console.log(`${ok ? '✔' : '✖'} ${label}`);
  if (!ok) failed++;
}
const has = (r, rule, text) => r.findings.some(f => f.rule === rule && (f.where + ' ' + f.detail).includes(text));

const react = audit('react');
expect('react: hardcoded JSX text', has(react, 'hardcoded-text', 'Pay now'));
expect('react: hardcoded placeholder attribute', has(react, 'hardcoded-attr', 'Enter discount code'));
expect('react: concatenated t() calls', has(react, 'concat', "t('cart.you'"));
expect('react: hand-rolled plural', has(react, 'manual-plural', 'count === 1'));
expect('react: dynamic key', has(react, 'dynamic-key', 'status.'));
expect('react: key with no fallback', has(react, 'no-fallback', 'cart.itemsLabel'));
expect('react: default drift', has(react, 'default-drift', 'checkout.payButton'));
expect('react: weak key name', has(react, 'naming', 'save2'));
expect('react: positional placeholder', has(react, 'positional-placeholder', '{0} shared {1}'));
expect('react: placeholder mismatch', has(react, 'placeholder-mismatch', '{total}'));
expect('react: Polish plural forms', has(react, 'plural-forms', 'few, many'));

const flutter = audit('flutter');
expect('flutter: gen_l10n detected from l10n.yaml', flutter.detected.some(d => d.includes('gen_l10n')));
expect('flutter: hardcoded Text()', has(flutter, 'hardcoded-text', 'Pay now'));
expect('flutter: hardcoded hintText', has(flutter, 'hardcoded-attr', 'hintText'));
expect('flutter: getters glued together', has(flutter, 'concat', 'l10n.youHave'));
expect('flutter: getter missing from template ARB', has(flutter, 'no-fallback', 'checkoutSubtitle'));
expect('flutter: int placeholder without plural', has(flutter, 'missing-plural', 'itemsLeft'));
expect('flutter: undocumented placeholder', has(flutter, 'placeholder-undocumented', '{name}'));
expect('flutter: ARB placeholder renamed in translation', has(flutter, 'placeholder-mismatch', 'cantidad'));
expect('flutter: asset paths and routes are not flagged', !flutter.findings.some(f => /logo\.png|\/checkout|checkout_nav/.test(f.detail)));

// Baseline round trip: a fresh baseline means zero new findings and a passing --ci run.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-audit-'));
const baseline = path.join(tmp, 'baseline.json');
run(path.join(__dirname, 'examples', 'react'), '--write-baseline', baseline, '--json');
const withBaseline = JSON.parse(run(path.join(__dirname, 'examples', 'react'), '--baseline', baseline, '--json'));
expect('baseline: no new findings right after writing it', withBaseline.summary.errors + withBaseline.summary.warnings + withBaseline.summary.info === 0);

// HTML report: written to the given file, shows the naming score, never leaks the absolute project path.
const htmlFile = path.join(tmp, 'report.html');
run(path.join(__dirname, 'examples', 'flutter'), '--html', htmlFile);
const html = fs.existsSync(htmlFile) ? fs.readFileSync(htmlFile, 'utf8') : '';
expect('html: report written with naming score and findings', html.includes('Key naming score') && html.includes('Hand-rolled plural') && html.includes('save2'));
expect('html: absolute project path not included', html && !html.includes(path.join(__dirname, 'examples')));
// Agent mode: plain fix list grouped by file, exit code 1 while errors remain.
const agentRun = (dir, ...args) => { try { execFileSync(process.execPath, [CLI, dir, '--agent', ...args], { encoding: 'utf8' }); return { code: 0 }; } catch (e) { return { code: e.status, out: e.stdout }; } };
const ag = agentRun(path.join(__dirname, 'examples', 'react'));
expect('agent: exits 1 with errors and lists file, line and rule', ag.code === 1 && /src\/Checkout\.jsx\n  E L\d+ \[/.test(ag.out) && ag.out.includes('How to fix:') && !ag.out.includes('\x1b['));
const agRule = agentRun(path.join(__dirname, 'examples', 'react'), '--rule', 'manual-plural');
expect('agent: --rule keeps only that rule', agRule.out.includes('[manual-plural]') && !agRule.out.includes('[hardcoded-text]'));

// Namespace-per-file layout: src/locales/en-US/ui.json is a namespace, not a language called "ui";
// arrays (returnObjects) and groups with keys named message/description are ordinary keys.
const ns = path.join(tmp, 'ns');
fs.mkdirSync(path.join(ns, 'src', 'locales', 'en-US'), { recursive: true });
fs.writeFileSync(path.join(ns, 'src', 'locales', 'en-US', 'ui.json'), JSON.stringify({ dialog: { close: 'Close dialog' } }));
fs.writeFileSync(path.join(ns, 'src', 'locales', 'en-US', 'landing.json'), JSON.stringify({ points: ['One', 'Two'], quote: { message: 'Message', description: 'Describe the project', cancel: 'Cancel quote' } }));
fs.writeFileSync(path.join(ns, 'src', 'App.jsx'), "export const A = () => <div>{t('dialog.close')}{t('points', { returnObjects: true })}{t('quote.cancel')}</div>;\n");
const nsr = JSON.parse(run(ns, '--json'));
expect('namespaces: ui.json is not a target language', nsr.sourceLocale === 'en-us' && nsr.targetLocales.length === 0);
expect('namespaces: keys in namespace files, arrays and message/description groups are found', !nsr.findings.some(f => f.rule === 'no-fallback'));

// --changed and --init-agent in a throwaway git repo.
const repo = path.join(tmp, 'repo');
fs.cpSync(path.join(__dirname, 'examples', 'react'), repo, { recursive: true });
const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'ignore' });
let gitOk = true;
try { git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'init'); } catch { gitOk = false; }
if (gitOk) {
  expect('changed: nothing reported when no files changed', agentRun(repo, '--changed').code === 0);
  fs.writeFileSync(path.join(repo, 'src', 'New.jsx'), 'export const N = ({ count }) => <p>{count === 1 ? "file" : "files"}</p>;\n');
  const ch = agentRun(repo, '--changed');
  expect('changed: only the new file is reported', ch.code === 1 && ch.out.includes('src/New.jsx') && !ch.out.includes('Checkout.jsx'));
  fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '# Notes\n');
  run(repo, '--init-agent'); run(repo, '--init-agent');
  const agents = fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8');
  expect('init-agent: AGENTS.md written once (idempotent) with the check command', agents.split('i18n-audit:start').length === 2 && agents.includes('--agent --changed'));
  expect('init-agent: CLAUDE.md imports AGENTS.md', fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8').includes('@AGENTS.md'));
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
