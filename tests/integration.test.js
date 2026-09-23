const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const test = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '..', 'Model.js'), 'utf8')
  .replace(/^\.pragma library\s*/, '')
  + `\nmodule.exports = { parseProcesses, buildSessions, killTargets, survivingTargets }\n`
const context = { module: { exports: {} }, exports: {}, console }
vm.runInNewContext(source, context, { filename: 'Model.js' })
const Model = context.module.exports

const matchers = [{ id: 'codex', name: 'Codex CLI', executables: ['codex'] }]
const psArgs = ['-eo', 'pid=,ppid=,pgid=,uid=,etimes=,lstart=,stat=,comm=,args=']

function processTable() {
  return Model.parseProcesses(execFileSync('ps', psArgs, { encoding: 'utf8' }))
}

function sessionsForCurrentUser() {
  return Model.buildSessions(processTable(), matchers, process.getuid())
}

function waitForSession(pid) {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    const session = sessionsForCurrentUser().find(item => item.pid === pid)
    if (session) return session
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
  }
  return null
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

test('fixture agent sessions are discovered and stopped child-first', async () => {
  // Launch through a short-lived helper so the fixture is reparented outside
  // this test's real Codex session. It advertises argv[0] as codex and starts
  // one sleep child, giving the model an independent process tree.
  const fixturePid = Number(execFileSync('bash', [
    '-c',
    "bash -c 'exec -a codex bash -c \"sleep 30 & wait\"' </dev/null >/dev/null 2>&1 & echo $!"
  ], { encoding: 'utf8' }).trim())
  assert.ok(Number.isInteger(fixturePid) && fixturePid > 1, 'fixture should return a valid PID')
  let session
  try {
    session = waitForSession(fixturePid)
    if (!session) {
      const related = processTable().filter(item => item.pid === fixturePid || item.ppid === fixturePid)
      assert.ok(session, `fixture session should be visible: ${JSON.stringify(related)}`)
    }
    assert.ok(session.childCount >= 1, 'fixture should include a child process')

    const targets = Model.killTargets(session)
    assert.equal(targets[targets.length - 1].process.pid, fixturePid)
    for (const target of targets) {
      try { process.kill(target.process.pid, 'SIGTERM') } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }

    const deadline = Date.now() + 2000
    while (Date.now() < deadline && processTable().some(item => item.pid === fixturePid)) await sleep(50)
    assert.equal(processTable().some(item => item.pid === fixturePid), false, 'fixture root should exit after SIGTERM')
    assert.equal(Model.survivingTargets(session, processTable(), process.getuid()).length, 0,
      'fixture descendants should be cleaned up')
  } finally {
    if (session) {
      for (const target of Model.killTargets(session)) {
        try { process.kill(target.process.pid, 'SIGKILL') } catch (error) {
          if (error.code !== 'ESRCH') throw error
        }
      }
    }
    try { process.kill(fixturePid, 'SIGKILL') } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  }
})
