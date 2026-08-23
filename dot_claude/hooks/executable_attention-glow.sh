#!/bin/sh
# Ask the edge-glow GNOME extension to pulse the Alacritty window this Claude
# Code session runs in, until that window is focused.
#
#   attention-glow.sh          -> start pulsing
#   attention-glow.sh stop     -> clear it now
#
# Mutter identifies windows by the client's pid, so walk up the process tree
# from this hook to the Alacritty process owning our window. That also makes
# the right window glow when several Claude sessions are open at once.
#
# Both start and stop carry that pid, so a session only ever touches its own
# window -- pressing enter in one terminal must not clear another's glow.
#
# Grok CLI loads these same hooks through its Claude-compatibility layer, and
# its event semantics differ in ways this script must absorb:
#
#   - Grok runs the hooks inside subagent sessions too, tagging the payload
#     with subagentType. A subagent finishing its turn is not the session
#     going idle, so those fires must neither start a glow mid-turn nor clear
#     the parent's.
#   - Grok fires an extra Stop at session end (reason channel_closed/shutdown)
#     after SessionEnd already cleared the glow. Ignore those so a dead
#     session cannot start pulsing. Claude Stop payloads have no reason field.
#   - Grok's Notification covers more than "the CLI wants you": task_complete
#     lands mid-turn when a background task finishes, and idle_prompt fires
#     about a minute after the session settles following ANY turn end -- even
#     one the user interrupted themselves, and even after they already focused
#     the window (only a new message cancels it, focusing does not). Both make
#     the window glow "for no reason", so of the typed notifications only
#     permission_prompt may glow; genuine completions already glow via Stop,
#     which persists until focus. Claude payloads have no notificationType.
#   - Turns that end on an API error or a runtime bail-out fire StopFailure /
#     StopCancelled instead of Stop. Those deserve a glow (the session halted
#     unattended) and are registered in ~/.grok/hooks/attention-glow.json;
#     here they simply fall through to the default start path. StopCancelled's
#     user-initiated reasons (interrupt, declined permission) are excluded by
#     that file's matcher -- the user is present for those.
#   - When a background command or subagent finishes, Grok injects a synthetic
#     turn whose promptId is "task-completed-...". That fires UserPromptSubmit
#     (which would clear a real glow) then a short agent turn then Stop (which
#     would pulse the window while you are idle, or chained a few seconds after
#     another task). Ignore both directions. Claude prompt IDs are UUIDs.
#   - Parent Stop can fire while backgroundTasks is still non-empty: the
#     session is paused waiting for that work, not idle. Don't glow then.
#
# Never fails loudly: a broken notification must not break the session.

COLOR="#E95420" # Ubuntu orange

DEST="org.gnome.Shell"
OBJ="/org/local/EdgeGlow"
IFACE="org.local.EdgeGlow"

pid=$$
depth=0
apid=""

while [ -n "$pid" ] && [ "$pid" != "1" ] && [ "$pid" != "0" ] && [ "$depth" -lt 16 ]; do
	case "$(cat "/proc/$pid/comm" 2>/dev/null)" in
	alacritty)
		apid="$pid"
		break
		;;
	esac
	pid=$(awk '{print $4}' "/proc/$pid/stat" 2>/dev/null)
	depth=$((depth + 1))
done

# No window of our own means nothing to start, and nothing of ours to stop.
[ -n "$apid" ] || exit 0

# Hook payloads arrive as JSON on stdin. A manual run from a terminal has no
# payload; don't block waiting for one.
input=""
[ -t 0 ] || input=$(cat)

field() {
	printf '%s' "$input" | jq -r "$1 // empty" 2>/dev/null
}

# Subagent fires (Grok-only, see header) are never ours to act on.
[ -n "$(field '.subagentType // .subagent_type')" ] && exit 0

# Grok background-task wakeups (see header). Check before start/stop so a
# synthetic UserPromptSubmit cannot clear a real glow and a synthetic Stop
# cannot start one.
case "$(field '.promptId // .prompt_id')" in
task-completed-*) exit 0 ;;
esac

if [ "$1" = "stop" ]; then
	gdbus call --session --dest "$DEST" --object-path "$OBJ" \
		--method "$IFACE.Stop" "uint32 $apid" >/dev/null 2>&1
	exit 0
fi

event=$(field '.hookEventName // .hook_event_name')
case "$event" in
[Ss]top)
	reason=$(field '.reason')
	if [ -n "$reason" ] && [ "$reason" != "end_turn" ]; then
		exit 0
	fi
	bg=$(printf '%s' "$input" | jq -r '(.backgroundTasks // .background_tasks // []) | length' 2>/dev/null)
	if [ -n "$bg" ] && [ "$bg" != "0" ]; then
		exit 0
	fi
	;;
[Nn]otification)
	ntype=$(field '.notificationType // .notification_type')
	if [ -n "$ntype" ]; then
		case "$ntype" in
		permission_prompt) ;;
		*) exit 0 ;;
		esac
	fi
	;;
esac

gdbus call --session --dest "$DEST" --object-path "$OBJ" \
	--method "$IFACE.Start" "uint32 $apid" "$COLOR" >/dev/null 2>&1

exit 0
