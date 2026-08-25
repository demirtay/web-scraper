/**
 * log.js
 * Minimal logger for the E2E harness: every line goes to stdout AND is
 * buffered for a final write to test-artifacts/latest/test.log — so a
 * failed run's log survives even if the process is killed mid-way (we
 * flush after every line, not just at the end).
 */
const fs = require('fs');
const path = require('path');

function createLogger(logFilePath) {
  fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
  const stream = fs.createWriteStream(logFilePath, { flags: 'w' });

  function line(level, msg) {
    const ts = new Date().toISOString();
    const text = `[${ts}] [${level}] ${msg}`;
    // eslint-disable-next-line no-console
    console.log(text);
    stream.write(text + '\n');
  }

  return {
    info: (msg) => line('INFO', msg),
    warn: (msg) => line('WARN', msg),
    error: (msg) => line('ERROR', msg),
    step: (msg) => line('STEP', msg),
    close: () => new Promise((resolve) => stream.end(resolve))
  };
}

module.exports = { createLogger };
