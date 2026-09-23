# Active Agents

An Omarchy bar widget that shows active AI coding-agent sessions owned by the
current user and lets you stop one session after an explicit confirmation.

The widget is deliberately separate from `omarchy.agents`, which reports
provider usage and limits. Active Agents only inspects local processes; it does
not make network requests, persist transcripts, or require elevated access.

## Install

```sh
omarchy plugin add https://github.com/NobiBot/omarchy-agent-monitor.git --enable
omarchy bar move io.github.nobibot.agent-monitor --section right
```

The plugin starts hidden when no supported agent is running. It appears with a
count when it detects Claude Code, Codex CLI, OpenCode, Aider, or Gemini CLI.
For Codex, this means standalone CLI sessions. ChatGPT's persistent Codex
`app-server` backend and its descendants are deliberately excluded, even with
custom matchers; stop desktop Codex tasks through the ChatGPT desktop app.
Click the icon to open the process list. Every stop action shows the agent,
PID, working directory, and process count before sending `SIGTERM`; processes
that remain after the grace period receive `SIGKILL` only if their identity is
still unchanged.

## Configuration

Settings are inline on the bar entry in `~/.config/omarchy/shell.json`:

```json
{
  "id": "io.github.nobibot.agent-monitor",
  "refreshIntervalSec": 3,
  "gracePeriodMs": 1500,
  "matchers": [
    { "id": "claude", "name": "Claude Code", "executables": ["claude", "claude-code"] },
    { "id": "codex", "name": "Codex CLI", "executables": ["codex"] },
    { "id": "opencode", "name": "OpenCode", "executables": ["opencode"] },
    { "id": "aider", "name": "Aider", "executables": ["aider"] },
    { "id": "gemini", "name": "Gemini CLI", "executables": ["gemini"] }
  ]
}
```

The matcher list uses executable basenames and the first command-line token;
it does not evaluate arbitrary regular expressions or shell fragments. For
example, a custom entry can be added for a local agent:

```json
{ "id": "my-agent", "name": "My Agent", "executables": ["my-agent"] }
```

The command-line settings can also be changed with `omarchy bar set`, using
`--json` for numbers and arrays. Editing `shell.json` directly is clearer for
the matcher list.

## Safety model

- Only processes with the current user’s UID are displayed or controlled.
- The plugin never calls `sudo`, `pkexec`, `killall`, or a shell to construct a
  process command.
- Before termination it re-scans the process table and requires the selected
  session and process identities to match the original snapshot.
- Descendants are terminated individually, children first; unrelated process
  groups are never targeted.
- Processes that change identity during the grace period are left untouched.

## Development and validation

```sh
omarchy plugin validate .
qmllint -I "$OMARCHY_PATH/shell" \
  BarWidget.qml Panel.qml ProcessModel.qml
node --test tests/model.test.js tests/integration.test.js
```

After enabling the plugin, use `r` to refresh, arrow or `j`/`k` navigation to
select a row, Enter to open or accept its confirmation, and Escape to close or
cancel.

## Remove

```sh
omarchy plugin remove io.github.nobibot.agent-monitor
```
