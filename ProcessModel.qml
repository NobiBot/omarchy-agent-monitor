import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model

Item {
  id: root
  visible: false

  property var settings: ({})
  property var sessions: []
  property bool busy: false
  property bool killing: false
  property string notice: ""
  property int currentUid: -1
  property bool refreshPending: false
  property bool scanReceived: false
  property var cwdQueue: []
  property int currentCwdPid: 0
  property string currentCwdText: ""
  property var killSession: null
  property var killQueue: []
  property string killPhase: ""
  property int killFailures: 0
  property int killChangedCount: 0
  property bool forceAttempted: false

  readonly property int refreshIntervalSec: Math.max(1, Math.min(60, Number(setting("refreshIntervalSec", 3)) || 3))
  readonly property int gracePeriodMs: Math.max(250, Math.min(10000, Number(setting("gracePeriodMs", 1500)) || 1500))
  readonly property var matchers: Model.normalizeMatchers(setting("matchers", null))

  signal killFinished(bool success, string message)

  function setting(name, fallback) {
    if (!settings || settings[name] === undefined || settings[name] === null) return fallback
    return settings[name]
  }

  function refresh() {
    if (root.killing) return
    if (uidProcess.running || scanProcess.running || cwdProcess.running) {
      refreshPending = true
      return
    }
    if (currentUid < 0) {
      uidProcess.running = true
      busy = true
      return
    }
    startScan()
  }

  function startScan() {
    if (scanProcess.running || root.killing) return
    scanReceived = false
    busy = true
    scanProcess.command = ["ps", "-eo", "pid=,ppid=,pgid=,uid=,etimes=,lstart=,stat=,comm=,args="]
    scanProcess.running = true
  }

  function consumeScan(output) {
    scanReceived = true
    var processes = Model.parseProcesses(output)
    sessions = Model.buildSessions(processes, matchers, currentUid, [Quickshell.processId])
    cwdQueue = []
    for (var i = 0; i < sessions.length; i++) cwdQueue.push(sessions[i].pid)
    readNextCwd()
  }

  function readNextCwd() {
    if (cwdProcess.running) return
    if (cwdQueue.length === 0) {
      finishRefresh()
      return
    }
    currentCwdPid = Number(cwdQueue.shift())
    currentCwdText = ""
    cwdProcess.command = ["readlink", "-f", "/proc/" + currentCwdPid + "/cwd"]
    cwdProcess.running = true
  }

  function applyCwd(pid, value) {
    var next = sessions.slice()
    for (var i = 0; i < next.length; i++) {
      if (next[i].pid === pid) {
        next[i].cwd = String(value || "").trim()
        break
      }
    }
    sessions = next
  }

  function finishRefresh() {
    busy = false
    if (refreshPending) {
      refreshPending = false
      Qt.callLater(root.refresh)
    }
  }

  function failRefresh(message) {
    busy = false
    notice = message
    if (refreshPending) {
      refreshPending = false
      Qt.callLater(root.refresh)
    }
  }

  function requestKill(session) {
    if (!session || root.killing) return
    killSession = session
    killPhase = "validate"
    killFailures = 0
    killChangedCount = 0
    forceAttempted = false
    notice = ""
    killing = true
    killScanProcess.command = ["ps", "-eo", "pid=,ppid=,pgid=,uid=,etimes=,lstart=,stat=,comm=,args="]
    killScanProcess.running = true
  }

  function consumeKillScan(output) {
    if (!killSession) return finishKill(false, "No session was selected.")
    var freshProcesses = Model.parseProcesses(output)
    var freshSessions = Model.buildSessions(freshProcesses, matchers, currentUid, [Quickshell.processId])
    var validated = Model.sessionFor(freshSessions, killSession)
    if (!validated) return finishKill(false, "The session changed or exited before it could be stopped.")

    killSession = validated
    killQueue = Model.killTargets(validated)
    killPhase = "term"
    sendNextSignal()
  }

  function sendNextSignal() {
    if (killProcess.running) return
    if (killQueue.length === 0) {
      if (killPhase === "term") {
        graceTimer.restart()
      } else if (killPhase === "kill") {
        verifyKillTimer.restart()
      }
      return
    }
    var target = killQueue.shift()
    killProcess.command = ["kill", "-" + (killPhase === "kill" ? "KILL" : "TERM"), String(target.process.pid)]
    killProcess.running = true
  }

  function beginForceVerification() {
    if (!killSession || finalKillScanProcess.running) return
    finalKillScanProcess.command = ["ps", "-eo", "pid=,ppid=,pgid=,uid=,etimes=,lstart=,stat=,comm=,args="]
    finalKillScanProcess.running = true
  }

  function consumeFinalKillScan(output) {
    if (!killSession) return finishKill(false, "The selected session is no longer available.")
    var freshProcesses = Model.parseProcesses(output)
    var survivors = Model.survivingTargets(killSession, freshProcesses, currentUid)
    killChangedCount = Model.changedTargets(killSession, freshProcesses, currentUid)
    if (survivors.length === 0) {
      if (killChangedCount > 0)
        return finishKill(false, "Some processes changed while stopping; they were left untouched.")
      return finishKill(true, "Agent session stopped.")
    }
    if (forceAttempted)
      return finishKill(false, "Some session processes remained after SIGKILL.")
    forceAttempted = true
    killQueue = survivors
    killPhase = "kill"
    sendNextSignal()
  }

  function finishKill(success, message) {
    killing = false
    busy = false
    killQueue = []
    killPhase = ""
    killSession = null
    notice = message
    killFinished(success, message)
    Qt.callLater(root.refresh)
  }

  Timer {
    id: graceTimer
    repeat: false
    interval: root.gracePeriodMs
    onTriggered: root.beginForceVerification()
  }

  Timer {
    id: verifyKillTimer
    repeat: false
    interval: 250
    onTriggered: root.beginForceVerification()
  }

  Timer {
    id: pollTimer
    interval: root.refreshIntervalSec * 1000
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: root.refresh()
  }

  Process {
    id: uidProcess
    command: ["id", "-u"]
    running: false
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.currentUid = parseInt(String(text || "").trim(), 10)
    }
    onExited: function(exitCode) {
      if (exitCode !== 0 || root.currentUid < 0) root.failRefresh("Could not determine the current user.")
      else root.startScan()
    }
  }

  Process {
    id: scanProcess
    running: false
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.consumeScan(text)
    }
    onExited: function(exitCode) {
      if (exitCode !== 0 && !root.scanReceived) root.failRefresh("Could not inspect running processes.")
    }
  }

  Process {
    id: cwdProcess
    running: false
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.currentCwdText = String(text || "").trim()
    }
    onExited: {
      root.applyCwd(root.currentCwdPid, root.currentCwdText)
      root.readNextCwd()
    }
  }

  Process {
    id: killScanProcess
    running: false
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.consumeKillScan(text)
    }
    onExited: function(exitCode) {
      if (exitCode !== 0) root.finishKill(false, "Could not re-check the selected session.")
    }
  }

  Process {
    id: finalKillScanProcess
    running: false
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.consumeFinalKillScan(text)
    }
    onExited: function(exitCode) {
      if (exitCode !== 0) root.finishKill(false, "Could not verify the termination result.")
    }
  }

  Process {
    id: killProcess
    running: false
    onExited: function(exitCode) {
      if (exitCode !== 0) root.killFailures++
      root.sendNextSignal()
    }
  }
}
