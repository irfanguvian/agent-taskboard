# shellcheck shell=sh disable=SC2034
# Sourced by deploy, install-launchd and cutover (D25). Not executable.
# Every path hangs off $HOME on purpose: tests run the scripts on a temp HOME.
TBHOME=$HOME/.taskboard
LIVE=$HOME/taskboard-live
LABEL=local.taskboard
DOMAIN=gui/$(id -u)
PLIST=$HOME/Library/LaunchAgents/$LABEL.plist
V1PLIST=$TBHOME/backup/$LABEL.plist.v1 # the v1 job's plist, kept out of LaunchAgents
NODE=${TB_NODE:-$HOME/.nvm/versions/node/v24.13.0/bin/node} # D30: one absolute node

die() { echo "$(basename "$0"): $*" >&2; exit 1; }

# The real home needs --yes. TB_REAL_HOME is the test seam for the comparison; default is the passwd home.
guard_home() {
  _real=$(cd "${TB_REAL_HOME:-$(eval "printf %s ~$(id -un)")}" && pwd -P) || die "cannot resolve the real home"
  _here=$(cd "$HOME" && pwd -P) || die "cannot resolve HOME ($HOME)"
  [ "$_here" = "$_real" ] || return 0
  for _a in "$@"; do [ "$_a" = --yes ] && return 0; done
  die "HOME is the real home ($HOME): pass --yes to run against it"
}

# Exit 0 when the file parses as {"tasks": [...]}.
has_tasks() { "$NODE" -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).tasks.map(() => 0)' "$1" 2> /dev/null; }

# Exit 0 when both v1/tbd tasks files hold the same tasks, same order. tbd adds `type`, so it is ignored.
same() {
  "$NODE" -e '
    const rows = (f) => JSON.parse(require("fs").readFileSync(f, "utf8")).tasks.map(({ type, ...r }) => r);
    require("assert").deepStrictEqual(rows(process.argv[1]), rows(process.argv[2]));' "$1" "$2"
}
