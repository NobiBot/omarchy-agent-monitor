.pragma library

function defaultMatchers() {
  return [
    { id: "claude", name: "Claude Code", executables: ["claude", "claude-code"] },
    { id: "codex", name: "Codex CLI", executables: ["codex"] },
    { id: "opencode", name: "OpenCode", executables: ["opencode"] },
    { id: "aider", name: "Aider", executables: ["aider"] },
    { id: "gemini", name: "Gemini CLI", executables: ["gemini"] }
  ]
}

function normalizeMatchers(raw) {
  var source = Array.isArray(raw) ? raw : defaultMatchers()
  var result = []
  for (var i = 0; i < source.length; i++) {
    var item = source[i]
    if (!item || typeof item !== "object") continue
    var executables = Array.isArray(item.executables) ? item.executables : []
    var names = []
    for (var j = 0; j < executables.length; j++) {
      var executable = String(executables[j] || "").trim().toLowerCase()
      if (executable !== "" && names.indexOf(executable) === -1) names.push(executable)
    }
    if (names.length === 0) continue
    result.push({
      id: String(item.id || names[0]),
      name: String(item.name || item.id || names[0]),
      executables: names
    })
  }
  return result
}

function basename(value) {
  var text = String(value || "").trim()
  if (text === "") return ""
  text = text.replace(/^['"]|['"]$/g, "")
  var parts = text.split("/")
  return String(parts[parts.length - 1] || "").toLowerCase()
}

function firstArg(args) {
  var text = String(args || "").trim()
  if (text === "") return ""
  var match = /^(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(text)
  return match ? (match[1] || match[2] || match[3] || "") : ""
}

function matcherForProcess(process, matchers) {
  if (!process) return null
  // argv[0] is the executable token the user actually launched. Prefer it to
  // comm, which may be inherited or rewritten by wrappers/sandboxes. Fall
  // back to comm only when ps could not provide an argument vector.
  var argv0 = basename(firstArg(process.args))
  var candidates = argv0 !== "" ? [argv0] : [basename(process.comm)]
  for (var i = 0; i < matchers.length; i++) {
    var matcher = matchers[i]
    for (var j = 0; j < candidates.length; j++) {
      if (candidates[j] !== "" && matcher.executables.indexOf(candidates[j]) !== -1)
        return matcher
    }
  }
  return null
}

// ps is requested with lstart (five fixed tokens) before the free-form args
// field. lstart gives us a stable PID-reuse guard while elapsed time remains
// available for display.
function parseProcessLine(line) {
  var text = String(line || "").trim()
  if (text === "") return null
  var fields = text.split(/\s+/)
  if (fields.length < 12) return null

  var pid = Number(fields[0])
  var ppid = Number(fields[1])
  var pgid = Number(fields[2])
  var uid = Number(fields[3])
  var elapsed = Number(fields[4])
  if (!isFinite(pid) || pid <= 0 || !isFinite(ppid) || ppid < 0 || !isFinite(pgid) || pgid < 0 || !isFinite(uid)) return null
  if (!isFinite(elapsed) || elapsed < 0) elapsed = 0

  var startToken = fields.slice(5, 10).join(" ")
  var args = fields.slice(12).join(" ").trim()
  var comm = String(fields[11] || "").trim()
  if (comm === "") return null
  return {
    pid: pid,
    ppid: ppid,
    pgid: pgid,
    uid: uid,
    elapsed: elapsed,
    startToken: startToken,
    stat: String(fields[10] || ""),
    comm: comm,
    args: args,
    identity: identityFor({ pid: pid, ppid: ppid, uid: uid, startToken: startToken, comm: comm, args: args })
  }
}

function parseProcesses(output) {
  var result = []
  var lines = String(output || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var process = parseProcessLine(lines[i])
    if (process) result.push(process)
  }
  return result
}

function identityFor(process) {
  return [process.pid, process.ppid, process.uid, process.startToken, process.comm, process.args].join("|")
}

function sameIdentity(a, b) {
  return !!a && !!b && identityFor(a) === identityFor(b)
}

function isExitedProcess(process) {
  return !!process && /^[ZX]/.test(String(process.stat || ""))
}

function buildSessions(processes, rawMatchers, currentUid, ignoredPids) {
  var matchers = normalizeMatchers(rawMatchers)
  var byPid = {}
  var owned = []
  var ignored = {}
  if (Array.isArray(ignoredPids)) {
    for (var x = 0; x < ignoredPids.length; x++) ignored[Number(ignoredPids[x])] = true
  }
  for (var i = 0; i < processes.length; i++) {
    var process = processes[i]
    if (!process || process.uid !== currentUid || ignored[process.pid] || isExitedProcess(process)) continue
    byPid[process.pid] = process
    owned.push(process)
  }

  var matched = {}
  for (var j = 0; j < owned.length; j++) {
    var matcher = matcherForProcess(owned[j], matchers)
    if (matcher) {
      owned[j].matcher = matcher
      matched[owned[j].pid] = true
    }
  }

  function hasMatchedAncestor(process) {
    var parent = byPid[process.ppid]
    var seen = {}
    while (parent && !seen[parent.pid]) {
      if (matched[parent.pid]) return true
      seen[parent.pid] = true
      parent = byPid[parent.ppid]
    }
    return false
  }

  var roots = []
  for (var k = 0; k < owned.length; k++) {
    if (matched[owned[k].pid] && !hasMatchedAncestor(owned[k])) roots.push(owned[k])
  }

  function membersFor(root) {
    var members = []
    var queue = [{ process: root, depth: 0 }]
    var seen = {}
    while (queue.length > 0) {
      var entry = queue.shift()
      var current = entry.process
      if (!current || seen[current.pid]) continue
      seen[current.pid] = true
      members.push({
        process: current,
        depth: entry.depth,
        identity: current.identity
      })
      for (var z = 0; z < owned.length; z++) {
        if (owned[z].ppid === current.pid && !seen[owned[z].pid])
          queue.push({ process: owned[z], depth: entry.depth + 1 })
      }
    }
    members.sort(function(a, b) { return a.depth - b.depth || a.process.pid - b.process.pid })
    return members
  }

  var sessions = []
  for (var r = 0; r < roots.length; r++) {
    var root = roots[r]
    var members = membersFor(root)
    sessions.push({
      key: root.identity,
      agentId: root.matcher.id,
      agentName: root.matcher.name,
      pid: root.pid,
      ppid: root.ppid,
      pgid: root.pgid,
      uid: root.uid,
      elapsed: root.elapsed,
      stat: root.stat,
      comm: root.comm,
      args: root.args,
      cwd: "",
      childCount: Math.max(0, members.length - 1),
      members: members
    })
  }
  sessions.sort(function(a, b) { return a.pid - b.pid })
  return sessions
}

function sessionFor(sessions, wanted) {
  if (!wanted || !Array.isArray(sessions)) return null
  for (var i = 0; i < sessions.length; i++) {
    if (sessions[i].pid === wanted.pid
        && sessions[i].agentId === wanted.agentId
        && sessions[i].key === wanted.key)
      return sessions[i]
  }
  return null
}

function killTargets(session) {
  if (!session || !Array.isArray(session.members)) return []
  var targets = session.members.slice()
  targets.sort(function(a, b) { return b.depth - a.depth || b.process.pid - a.process.pid })
  return targets
}

function survivingTargets(session, freshProcesses, currentUid) {
  var byPid = {}
  for (var i = 0; i < freshProcesses.length; i++) {
    if (freshProcesses[i].uid === currentUid && !isExitedProcess(freshProcesses[i]))
      byPid[freshProcesses[i].pid] = freshProcesses[i]
  }
  var survivors = []
  var targets = killTargets(session)
  for (var j = 0; j < targets.length; j++) {
    var current = byPid[targets[j].process.pid]
    if (current && sameIdentity(current, targets[j].process)) survivors.push({
      process: current,
      depth: targets[j].depth,
      identity: current.identity
    })
  }
  survivors.sort(function(a, b) { return b.depth - a.depth || b.process.pid - a.process.pid })
  return survivors
}

function formatDuration(seconds) {
  var value = Math.max(0, Number(seconds) || 0)
  var minutes = Math.floor(value / 60)
  var hours = Math.floor(minutes / 60)
  var days = Math.floor(hours / 24)
  if (days > 0) return days + "d " + (hours % 24) + "h"
  if (hours > 0) return hours + "h " + (minutes % 60) + "m"
  if (minutes > 0) return minutes + "m"
  return Math.max(1, Math.floor(value)) + "s"
}

function shortPath(path) {
  var value = String(path || "").trim()
  if (value === "") return "working directory unavailable"
  // This function only normalizes the path and keeps it safe as plain text.
  return value.length > 72 ? "…" + value.slice(-69) : value
}

function changedTargets(session, freshProcesses, currentUid) {
  if (!session || !Array.isArray(session.members)) return 0
  var byPid = {}
  for (var i = 0; i < freshProcesses.length; i++) {
    if (freshProcesses[i].uid === currentUid && !isExitedProcess(freshProcesses[i]))
      byPid[freshProcesses[i].pid] = freshProcesses[i]
  }
  var changed = 0
  for (var j = 0; j < session.members.length; j++) {
    var original = session.members[j].process
    var current = byPid[original.pid]
    if (current && !sameIdentity(current, original)) changed++
  }
  return changed
}
