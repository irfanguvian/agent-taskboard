#!/bin/sh
# ask-sound: Claude Code hook. Plays a sound + Mac notification when Claude waits on a human decision.
# Usage (hook command): scripts/ask-sound.sh "<title>"   (hook JSON on stdin is drained, not needed)
# Quiet hours 22:00-07:00 Asia/Jakarta: does nothing (plan D28).
# Test overrides: TB_NOW_HHMM=2230, AFPLAY_BIN, OSASCRIPT_BIN.
cat >/dev/null 2>&1
now=${TB_NOW_HHMM:-$(TZ=Asia/Jakarta date +%H%M)}
# shellcheck disable=SC2003 # expr strips leading zeros portably (no bash 10#)
now=$(expr "$now" + 0)
if [ "$now" -ge 2200 ] || [ "$now" -lt 700 ]; then exit 0; fi
"${AFPLAY_BIN:-afplay}" /System/Library/Sounds/Glass.aiff >/dev/null 2>&1 &
"${OSASCRIPT_BIN:-osascript}" -e 'on run argv' -e 'display notification (item 1 of argv) with title "Claude needs you"' -e 'end run' "${1:-Decision waiting}" >/dev/null 2>&1 &
exit 0
