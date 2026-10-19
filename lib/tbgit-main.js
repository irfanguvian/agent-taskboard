'use strict';
// bin/tb-git's entry (security review L1): the bash wrapper execs this with TB_NODE, the board's own node, so no node
// found on the run's PATH ever runs the bridge. The bridge itself: lib/tbgit.js.
require('./tbgit').main(process.argv.slice(2));
