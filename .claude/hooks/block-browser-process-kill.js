#!/usr/bin/env node
/**
 * block-browser-process-kill.js
 * PreToolUse hook (Bash|PowerShell) — technical enforcement of this
 * repository's Browser Process Safety rule (see CLAUDE.md, "## Browser
 * Process Safety — CRITICAL").
 *
 * BLOCKS any command that terminates a process BY NAME/IMAGE/PATTERN —
 * taskkill /IM, pkill, killall, Stop-Process -Name, a Get-Process |
 * Stop-Process pipeline, or a wmic process ... delete query — because
 * every one of those is indiscriminate across the WHOLE system: it kills
 * every matching process, including a user's own personal Chrome/Edge/
 * Firefox windows a test run never launched, not just whatever an
 * automated browser test happened to spawn.
 *
 * NEVER blocks precise, PID-scoped termination (taskkill /PID <pid>,
 * `kill <pid>`, Stop-Process -Id <pid>) — those can only ever affect the
 * one exact process named by that PID, which is exactly the sanctioned
 * cleanup path: a test harness that recorded the PID of the browser
 * process IT launched (or, more simply, holds the Playwright
 * context/browser object reference itself and calls context.close()/
 * browser.close()) may close exactly that one process.
 *
 * This hook does not try to guess whether a given command is
 * "browser-related" by looking for chrome/msedge/firefox in it — every
 * name-based kill command listed above is blocked outright, regardless
 * of target, because there is no legitimate use for one in this
 * repository's workflow, and narrowing the match to "looks like a
 * browser name" would just invite an easy bypass (a differently-cased or
 * differently-spelled target, a variable, a wildcard).
 */
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  let data;
  try { data = JSON.parse(input); } catch (e) { process.exit(0); }
  const cmd = (data && data.tool_input && data.tool_input.command) || '';
  if (!cmd) { process.exit(0); }

  const DANGEROUS_PATTERNS = [
    // taskkill: dangerous when it uses /IM (image name) without ALSO
    // using /PID somewhere in the same command. Windows taskkill accepts
    // /IM and /PID as independent, combinable filters — a command using
    // /PID alone (never /IM) is precise and always allowed.
    { re: /\btaskkill\b(?:(?!\/pid\b)[\s\S])*\/im\b/i, label: 'taskkill /IM (kills every process with that image name, system-wide)' },
    { re: /\bpkill\b/i, label: 'pkill (matches by process name/pattern, system-wide)' },
    { re: /\bkillall\b/i, label: 'killall (matches by process name, system-wide)' },
    // Stop-Process: dangerous when it uses -Name without -Id.
    { re: /Stop-Process\b(?:(?!-Id\b)[\s\S])*-Name\b/i, label: 'Stop-Process -Name (matches by name, system-wide)' },
    { re: /Get-Process\b[^\n|]*\|\s*Stop-Process\b/i, label: 'Get-Process | Stop-Process pipeline (matches by name/pattern, system-wide)' },
    { re: /wmic\s+process\s+where[^\n]*delete/i, label: 'wmic process ... delete (matches by WMI query, can hit unrelated processes)' }
  ];

  for (const p of DANGEROUS_PATTERNS) {
    if (p.re.test(cmd)) {
      const reason =
        'BLOCKED by the Browser Process Safety rule (CLAUDE.md, "## Browser Process Safety — CRITICAL"): ' +
        'this command (' + p.label + ') is a broad, name-based process-kill that could terminate ' +
        'browser windows (or anything else) this session never launched, including the user\'s own ' +
        'personal Chrome/Edge/Firefox. Only PID-scoped termination of a process THIS test run itself ' +
        'recorded is permitted (e.g. `taskkill /PID <pid>` with no /IM, `kill <pid>`, `Stop-Process -Id <pid>` ' +
        'with no -Name). For real-browser tests, close ONLY the Playwright context/browser object this run ' +
        'itself created — context.close() / browser.close() — never an OS-level name-based kill. If browser ' +
        'ownership cannot be determined with certainty, leave the browser open and report it rather than ' +
        'closing anything.';
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason
        }
      }));
      process.exit(0);
    }
  }
  process.exit(0);
});
