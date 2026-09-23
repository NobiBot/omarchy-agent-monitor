import QtQuick
import QtQuick.Controls
import Quickshell
import qs.Commons
import qs.Ui
import "Model.js" as Model

Panel {
  id: root
  moduleName: "io.github.nobibot.agent-monitor"
  ipcTarget: "io.github.nobibot.agent-monitor"
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null
  property var settings: ({})
  property bool cursorActive: false
  property int cursorIndex: 0
  property bool confirming: false
  property var confirmationSession: null
  property string notice: ""

  readonly property var barIdentity: hostWidget || root
  readonly property int activeCount: monitor.sessions.length
  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.45)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  ProcessModel {
    id: monitor
    settings: root.settings
    onKillFinished: function(success, message) {
      root.confirming = false
      root.confirmationSession = null
      root.notice = message
      root.cursorActive = false
    }
  }

  function open() {
    root.controller.show()
    monitor.refresh()
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  function close() {
    confirming = false
    confirmationSession = null
    root.controller.hide()
  }

  function toggle() {
    if (root.opened) root.close()
    else root.open()
  }

  function closeForPopoutSwitch() { root.close() }

  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.barIdentity, direction)
    return false
  }

  function refresh() { monitor.refresh() }

  function select(index) {
    if (monitor.sessions.length === 0) return
    cursorActive = true
    cursorIndex = Math.max(0, Math.min(monitor.sessions.length - 1, index))
  }

  function moveCursor(delta) {
    if (monitor.sessions.length === 0) return
    var next = cursorActive ? cursorIndex + delta : (delta > 0 ? 0 : monitor.sessions.length - 1)
    select((next + monitor.sessions.length) % monitor.sessions.length)
  }

  function requestKill(session) {
    if (!session || monitor.killing) return
    confirmationSession = session
    confirming = true
    notice = ""
    cursorActive = false
  }

  function confirmKill() {
    if (!confirmationSession || monitor.killing) return
    monitor.requestKill(confirmationSession)
  }

  function cancelKill() {
    confirming = false
    confirmationSession = null
  }

  onOpenedChanged: if (opened) {
    root.notice = ""
    root.cursorActive = false
    monitor.refresh()
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(460))
    contentHeight: panel.fittedContentHeight(contentColumn.implicitHeight, Style.space(620))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onMoveRequested: function(dx, dy) {
        if (root.confirming) return
        if (dy !== 0) root.moveCursor(dy)
        if (dx !== 0) root.moveCursor(dx)
      }
      onActivateRequested: {
        if (root.confirming) root.confirmKill()
        else if (root.cursorActive && monitor.sessions[root.cursorIndex])
          root.requestKill(monitor.sessions[root.cursorIndex])
      }
      onCloseRequested: root.confirming ? root.cancelKill() : root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(t) {
        if (t === "r" || t === "R") root.refresh()
        else if (root.confirming && (t === "y" || t === "Y")) root.confirmKill()
        else if (root.confirming && (t === "n" || t === "N")) root.cancelKill()
      }

      Flickable {
        id: flick
        anchors.fill: parent
        contentWidth: width
        contentHeight: contentColumn.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        interactive: contentHeight > height
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        Column {
          id: contentColumn
          width: flick.width
          spacing: Style.space(10)

          Row {
            width: parent.width
            spacing: Style.space(10)

            Text {
              text: "󰚩"
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.display
            }

            Column {
              width: parent.width - x - Style.space(10)
              spacing: Style.space(2)
              Text {
                text: "Active Agents"
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.heading
                font.bold: true
              }
              Text {
                text: monitor.killing ? "Stopping selected session…" : monitor.busy ? "Refreshing process list…" : root.activeCount + " active session" + (root.activeCount === 1 ? "" : "s")
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
              }
            }
          }

          Text {
            visible: root.notice !== ""
            width: parent.width
            text: root.notice
            color: root.notice.indexOf("stopped") >= 0 ? root.foreground : root.urgent
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            wrapMode: Text.WordWrap
          }

          BorderSurface {
            visible: root.confirming
            width: parent.width
            implicitHeight: confirmColumn.implicitHeight + Style.space(20)
            color: Style.hoverFillFor(root.urgent, root.urgent)
            borderSpec: Border.controlSpec("normal", root.urgent, root.urgent)
            radius: Style.cornerRadius

            Column {
              id: confirmColumn
              anchors.fill: parent
              anchors.margins: Style.space(10)
              spacing: Style.space(7)

              Text {
                width: parent.width
                text: "Stop " + (root.confirmationSession ? root.confirmationSession.agentName : "this agent") + "?"
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.title
                font.bold: true
              }
              Text {
                width: parent.width
                text: root.confirmationSession ? "PID " + root.confirmationSession.pid + " · " + (root.confirmationSession.cwd || "working directory unavailable") + " · " + (root.confirmationSession.childCount + 1) + " processes" : ""
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                wrapMode: Text.Wrap
                elide: Text.ElideMiddle
              }
              Row {
                spacing: Style.space(6)
                PanelActionButton {
                  iconText: "󰄬"
                  tooltipText: "Confirm stop (Enter or Y)"
                  foreground: root.foreground
                  hoverColor: root.urgent
                  fontFamily: root.fontFamily
                  onClicked: root.confirmKill()
                }
                Text {
                  anchors.verticalCenter: parent.verticalCenter
                  text: "Confirm"
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                }
                PanelActionButton {
                  iconText: "󰜺"
                  tooltipText: "Cancel (Escape or N)"
                  foreground: root.foreground
                  hoverColor: Color.accent
                  fontFamily: root.fontFamily
                  onClicked: root.cancelKill()
                }
                Text {
                  anchors.verticalCenter: parent.verticalCenter
                  text: "Cancel"
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                }
              }
            }
          }

          Text {
            visible: !root.confirming && root.activeCount === 0
            width: parent.width
            text: monitor.busy ? "Looking for active agents…" : "No active agents found."
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
          }

          Repeater {
            model: monitor.sessions
            delegate: CursorSurface {
              required property var modelData
              required property int index
              width: contentColumn.width
              height: sessionColumn.implicitHeight + Style.space(20)
              hasCursor: root.cursorActive && root.cursorIndex === index
              foreground: root.foreground
              accent: Color.accent

              MouseArea {
                anchors.fill: parent
                hoverEnabled: true
                onContainsMouseChanged: if (containsMouse) root.select(index)
                onClicked: root.select(index)
              }

              Column {
                id: sessionColumn
                anchors.left: parent.left
                anchors.right: killButton.left
                anchors.leftMargin: Style.space(10)
                anchors.rightMargin: Style.space(8)
                anchors.verticalCenter: parent.verticalCenter
                spacing: Style.space(3)

                Text {
                  width: parent.width
                  text: modelData.agentName + "  ·  PID " + modelData.pid
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.title
                  font.bold: true
                  elide: Text.ElideRight
                }
                Text {
                  width: parent.width
                  text: (modelData.cwd || "working directory unavailable")
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                  elide: Text.ElideMiddle
                }
                Text {
                  width: parent.width
                  text: Model.formatDuration(modelData.elapsed) + " · " + modelData.childCount + " child" + (modelData.childCount === 1 ? "" : "ren") + " · " + modelData.stat
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  elide: Text.ElideRight
                }
              }

              PanelActionButton {
                id: killButton
                anchors.right: parent.right
                anchors.rightMargin: Style.space(8)
                anchors.verticalCenter: parent.verticalCenter
                iconText: "󰆴"
                tooltipText: "Stop this agent"
                foreground: root.foreground
                hoverColor: root.urgent
                fontFamily: root.fontFamily
                enabled: !monitor.killing
                onClicked: root.requestKill(modelData)
              }
            }
          }
        }
      }
    }
  }
}
