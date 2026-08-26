/**
 * check-test-infra-safety.js
 * Static regression guard for the Browser Process Safety rule (see
 * CLAUDE.md, "## Browser Process Safety — CRITICAL").
 *
 * Scans this repository's own dev-tooling/test-infrastructure source
 * (e2e/, scripts/, package.json — NEVER the shipped extension runtime,
 * which this check deliberately does not touch) for broad, name-based
 * process-termination commands — taskkill /IM, pkill, killall,
 * Stop-Process -Name, a Get-Process|Stop-Process pipeline, wmic
 * process ... delete — the same pattern set
 * .claude/hooks/block-browser-process-kill.js blocks live, at the
 * Bash/PowerShell tool-call level, for any agent session working in this
 * repo. That hook only protects an interactive Claude Code session;
 * THIS check is what guarantees the repo's own committed code can never
 * quietly reintroduce the same danger (a script run outside any agent
 * session, a future contributor pasting a "quick cleanup" one-liner,
 * CI, etc.) — belt and suspenders, two independent enforcement layers.
 *
 * PID-scoped termination (taskkill /PID, `kill <pid>`, Stop-Process -Id)
 * is intentionally NOT flagged — it can only ever affect one exact,
 * already-identified process, which is the sanctioned cleanup path this
 * project's own e2e/lib/browser.js already uses (context.close(), an
 * ownership-scoped Playwright API call, never an OS-level kill at all).
 *
 * Usage: node scripts/check-test-infra-safety.js  (exit 0 = clean, 1 = found)
 */
'use strict';
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['e2e', 'scripts'];
const SCAN_FILES = ['package.json'];
const EXTS = new Set(['.js', '.json', '.ps1', '.sh', '.cjs', '.mjs']);

const DANGEROUS_PATTERNS = [
  { re: /\btaskkill\b(?:(?!\/pid\b)[\s\S])*\/im\b/i, label: 'taskkill /IM without /PID (kills every process with that image name, system-wide)' },
  { re: /\bpkill\b/i, label: 'pkill (matches by process name/pattern, system-wide)' },
  { re: /\bkillall\b/i, label: 'killall (matches by process name, system-wide)' },
  { re: /Stop-Process\b(?:(?!-Id\b)[\s\S])*-Name\b/i, label: 'Stop-Process -Name without -Id (matches by name, system-wide)' },
  { re: /Get-Process\b[^\n|]*\|\s*Stop-Process\b/i, label: 'Get-Process | Stop-Process pipeline (matches by name/pattern, system-wide)' },
  { re: /wmic\s+process\s+where[^\n]*delete/i, label: 'wmic process ... delete (matches by WMI query, can hit unrelated processes)' },
  { re: /process\.kill\s*\(\s*-\s*\d/i, label: 'process.kill() with a negative PID (kills an entire process GROUP, not one process)' }
];

function walk(dirRel, out) {
  const abs = path.join(PROJECT_ROOT, dirRel);
  if (!fs.existsSync(abs)) return;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const relPath = path.join(dirRel, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      walk(relPath, out);
    } else if (EXTS.has(path.extname(entry.name))) {
      out.push(relPath);
    }
  }
}

function main() {
  const files = [];
  SCAN_DIRS.forEach((d) => walk(d, files));
  SCAN_FILES.forEach((f) => { if (fs.existsSync(path.join(PROJECT_ROOT, f))) files.push(f); });

  // This checker's own source legitimately CONTAINS the pattern text (as
  // regex literals, to define what it looks for), and e2e/lib/browser.js
  // / e2e/browser-ownership-safety-check.js legitimately DISCUSS these
  // exact command names in prose comments (documenting what they must
  // never do, and why) — none of that is an executable occurrence of the
  // danger this check exists to catch. Excluded from the PATTERN scan
  // only, never from the safety RULE itself (which is exactly why this
  // check's own docstring above, and both excluded files' own header
  // comments, spell the rule out in the first place).
  const SELF_EXCLUDE = new Set([
    path.join('scripts', 'check-test-infra-safety.js'),
    path.join('e2e', 'lib', 'browser.js'),
    path.join('e2e', 'browser-ownership-safety-check.js')
  ]);

  const offenders = [];
  files.forEach((relPath) => {
    if (SELF_EXCLUDE.has(relPath)) return;
    const abs = path.join(PROJECT_ROOT, relPath);
    let src;
    try { src = fs.readFileSync(abs, 'utf8'); } catch (e) { return; }
    DANGEROUS_PATTERNS.forEach((p) => {
      if (p.re.test(src)) offenders.push(relPath + ': ' + p.label);
    });
  });

  if (offenders.length) {
    console.error('FAIL: dangerous broad/name-based process-kill pattern(s) found in test infrastructure:');
    offenders.forEach((o) => console.error('  - ' + o));
    console.error('\nSee CLAUDE.md, "## Browser Process Safety — CRITICAL". Use PID-scoped termination of a process this run itself recorded, or (preferred) the owned Playwright context/browser object\'s own close()/closeUp().');
    process.exit(1);
  }
  console.log('PASS: no broad/name-based process-kill patterns found in ' + SCAN_DIRS.join(', ') + ', package.json (' + files.length + ' files scanned)');
  process.exit(0);
}

main();
