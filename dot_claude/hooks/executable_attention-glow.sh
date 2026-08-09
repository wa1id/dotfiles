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

if [ "$1" = "stop" ]; then
	gdbus call --session --dest "$DEST" --object-path "$OBJ" \
		--method "$IFACE.Stop" "uint32 $apid" >/dev/null 2>&1
	exit 0
fi

gdbus call --session --dest "$DEST" --object-path "$OBJ" \
	--method "$IFACE.Start" "uint32 $apid" "$COLOR" >/dev/null 2>&1

exit 0
