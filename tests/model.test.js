const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')

const source = fs.readFileSync(path.join(__dirname, '..', 'Model.js'), 'utf8')
  .replace(/^\.pragma library\s*/, '')
  + `\nmodule.exports = {\n    parseProcessLine, parseProcesses, normalizeMatchers, matcherForProcess,\n    buildSessions, sessionFor, killTargets, survivingTargets, changedTargets,\n    sameIdentity, formatDuration\n  }\n`
const context = { module: { exports: {} }, exports: {}, console }
vm.runInNewContext(source, context, { filename: 'Model.js' })
const Model = context.module.exports

const matchers = [
  { id: 'codex', name: 'Codex CLI', executables: ['codex'] },
  { id: 'local', name: 'Local Agent', executables: ['local-agent'] }
]

function line(pid, ppid, uid, elapsed, stat, comm, args, startToken = 'Wed Sep 23 13:00:00 2026') {
  return `${pid} ${ppid} ${pid} ${uid} ${elapsed} ${startToken} ${stat} ${comm} ${args || ''}`
}

test('malformed process records are ignored', () => {
  const parsed = Model.parseProcesses([
    'not a process',
    line(10, 1, 1000, 12, 'S', 'codex', 'codex --continue'),
    '1 2 nope'
  ].join('\n'))
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].pid, 10)
})

test('no matching processes produces no sessions', () => {
  const processes = Model.parseProcesses(line(10, 1, 1000, 12, 'S', 'bash', 'bash'))
  assert.equal(Model.buildSessions(processes, matchers, 1000).length, 0)
})

test('exited and zombie agent records are ignored', () => {
  const processes = Model.parseProcesses([
    line(13, 1, 1000, 12, 'Z', 'codex', '[codex] <defunct>'),
    line(14, 1, 1000, 12, 'X', 'codex', 'codex')
  ].join('\n'))
  assert.equal(Model.buildSessions(processes, matchers, 1000).length, 0)
})

test('one session contains its descendants and metadata', () => {
  const processes = Model.parseProcesses([
    line(10, 1, 1000, 120, 'S', 'codex', 'codex --continue'),
    line(11, 10, 1000, 90, 'S', 'node', 'node worker.js'),
    line(12, 11, 1000, 30, 'R', 'bash', 'bash helper.sh')
  ].join('\n'))
  const sessions = Model.buildSessions(processes, matchers, 1000)
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].agentName, 'Codex CLI')
  assert.equal(sessions[0].childCount, 2)
  assert.equal(JSON.stringify(Model.killTargets(sessions[0]).map(x => x.process.pid)), JSON.stringify([12, 11, 10]))
})

test('nested matching agents remain one session rooted at the first match', () => {
  const processes = Model.parseProcesses([
    line(20, 1, 1000, 100, 'S', 'codex', 'codex'),
    line(21, 20, 1000, 90, 'S', 'codex', 'codex subcommand'),
    line(22, 1, 1000, 80, 'S', 'local-agent', 'local-agent')
  ].join('\n'))
  const sessions = Model.buildSessions(processes, matchers, 1000)
  assert.equal(JSON.stringify(sessions.map(x => x.pid)), JSON.stringify([20, 22]))
  assert.equal(sessions[0].childCount, 1)
})

test('other users are excluded', () => {
  const processes = Model.parseProcesses([
    line(30, 1, 2000, 10, 'S', 'codex', 'codex'),
    line(31, 1, 1000, 10, 'S', 'bash', 'bash')
  ].join('\n'))
  assert.equal(Model.buildSessions(processes, matchers, 1000).length, 0)
})

test('the Omarchy shell process is excluded even if a matcher names it', () => {
  const processes = Model.parseProcesses(line(32, 1, 1000, 10, 'S', 'quickshell', 'quickshell'))
  const shellMatcher = [{ id: 'shell', name: 'Shell', executables: ['quickshell'] }]
  assert.equal(Model.buildSessions(processes, shellMatcher, 1000, [32]).length, 0)
})

test('multiple independent agent processes create separate sessions', () => {
  const processes = Model.parseProcesses([
    line(33, 1, 1000, 10, 'S', 'codex', 'codex'),
    line(34, 1, 1000, 10, 'S', 'local-agent', 'local-agent')
  ].join('\n'))
  assert.equal(Model.buildSessions(processes, matchers, 1000).length, 2)
})

test('desktop Codex app-server and its descendants are not standalone sessions', () => {
  const processes = Model.parseProcesses([
    line(60, 1, 1000, 100, 'S', 'codex', '/usr/lib/chatgpt/resources/codex -c features.code_mode_host=true app-server --analytics-default-enabled'),
    line(61, 60, 1000, 90, 'S', 'codex', 'codex --continue'),
    line(62, 61, 1000, 80, 'S', 'local-agent', 'local-agent'),
    line(63, 1, 1000, 70, 'S', 'codex', 'codex app-server'),
    line(64, 63, 1000, 60, 'S', 'codex', 'codex --continue'),
    line(65, 1, 1000, 50, 'S', 'codex', 'codex --continue')
  ].join('\n'))
  const sessions = Model.buildSessions(processes, matchers, 1000)
  assert.equal(JSON.stringify(sessions.map(item => item.pid)), JSON.stringify([65]))
  assert.equal(sessions[0].agentId, 'codex')
})

test('app-server exclusion applies to custom matchers and stale selections', () => {
  const custom = [{ id: 'all-codex', name: 'All Codex', executables: ['codex'] }]
  const after = Model.parseProcesses([
    line(70, 1, 1000, 30, 'S', 'codex', 'codex app-server'),
    line(71, 70, 1000, 20, 'S', 'codex', 'codex --continue')
  ].join('\n'))
  // This models a popup selection captured before the exclusion was applied.
  const selected = { pid: 70, agentId: 'all-codex', key: after[0].identity }
  const fresh = Model.buildSessions(after, custom, 1000)
  assert.equal(fresh.length, 0)
  assert.equal(Model.sessionFor(fresh, selected), null)
})

test('app-server must be a whole argument token', () => {
  const processes = Model.parseProcesses([
    line(72, 1, 1000, 20, 'S', 'codex', 'codex --config app-server-enabled'),
    line(73, 1, 1000, 20, 'S', 'codex', 'codex --project /tmp/app-server')
  ].join('\n'))
  assert.equal(JSON.stringify(Model.buildSessions(processes, matchers, 1000).map(item => item.pid)), JSON.stringify([72, 73]))
})

test('custom executable matchers are honored', () => {
  const process = Model.parseProcessLine(line(40, 1, 1000, 1, 'S', 'local-agent', 'local-agent --task'))
  assert.equal(Model.matcherForProcess(process, matchers).id, 'local')
  assert.equal(Model.normalizeMatchers(null).length, 5)
})

test('comm alone cannot impersonate an agent when argv zero differs', () => {
  const process = Model.parseProcessLine(
    line(41, 1, 1000, 1, 'S', 'codex', 'codex-linux-sandbox --task')
  )
  assert.equal(Model.matcherForProcess(process, matchers), null)
})

test('elapsed time changes do not change process identity', () => {
  const first = Model.parseProcessLine(line(42, 1, 1000, 1, 'S', 'codex', 'codex'))
  const later = Model.parseProcessLine(line(42, 1, 1000, 10, 'S', 'codex', 'codex'))
  assert.equal(Model.sameIdentity(first, later), true)
})

test('changed process identities are never force-kill survivors', () => {
  const original = Model.parseProcesses(line(50, 1, 1000, 50, 'S', 'codex', 'codex'))
  const session = Model.buildSessions(original, matchers, 1000)[0]
  const changed = Model.parseProcesses(line(50, 1, 1000, 0, 'S', 'bash', 'bash'))
  assert.equal(Model.survivingTargets(session, changed, 1000).length, 0)
  assert.equal(Model.changedTargets(session, changed, 1000), 1)
})

test('an exited session cannot be revalidated', () => {
  const original = Model.parseProcesses(line(51, 1, 1000, 50, 'S', 'codex', 'codex'))
  const wanted = Model.buildSessions(original, matchers, 1000)[0]
  assert.equal(Model.sessionFor([], wanted), null)
})

test('formatDuration produces compact readable labels', () => {
  assert.equal(Model.formatDuration(5), '5s')
  assert.equal(Model.formatDuration(125), '2m')
  assert.equal(Model.formatDuration(3720), '1h 2m')
})
