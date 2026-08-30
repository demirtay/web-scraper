/**
 * assert.js
 * The smallest possible shared test harness — matches this project's
 * own established convention exactly (CLAUDE.md: "Node scripts (no
 * test framework)... asserting via a small local assert() helper and
 * printing N assertions, N failures"), just factored into one shared
 * module now that tests/unit/ is a permanent, committed part of the
 * FAST test level instead of a throwaway scratch file.
 */
'use strict';

function makeSuite(name) {
  var assertions = 0;
  var failures = 0;
  var failureMessages = [];

  function assert(cond, msg) {
    assertions++;
    if (!cond) {
      failures++;
      failureMessages.push(msg);
      console.error('FAIL: ' + msg);
    }
  }

  function summarize() {
    console.log('[' + name + '] ' + assertions + ' assertions, ' + failures + ' failures');
    return { name: name, assertions: assertions, failures: failures, failureMessages: failureMessages };
  }

  return { assert: assert, summarize: summarize };
}

module.exports = { makeSuite: makeSuite };
