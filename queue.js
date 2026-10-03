// Task queue: a claude-queue.md file in the project folder with one task per line, written as
//   - [ ] build the login page
// takeNext() ticks the first open task and returns it.
const fs = require('fs');
const path = require('path');

const FILE = 'claude-queue.md';
const OPEN = /^([ \t]*[-*][ \t]*)\[ \]([ \t]+)(\S[^\r\n]*)/m;
const OPEN_ALL = /^[ \t]*[-*][ \t]*\[ \][ \t]+\S/gm;
const DONE_ALL = /^[ \t]*[-*][ \t]*\[[xX]\][ \t]+\S/gm;

// the session may have moved into a subfolder, so look a few levels up as well
function findFile(cwd) {
  let dir = cwd;
  for (let i = 0; i < 4; i++) {
    const file = path.join(dir, FILE);
    if (fs.existsSync(file)) return file;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

// Returns { text, position, total } for the task just taken, or null when there is none.
function takeNext(cwd) {
  try {
    const file = findFile(cwd);
    if (!file) return null;
    const text = fs.readFileSync(file, 'utf8');
    const match = OPEN.exec(text);
    if (!match) return null;
    const ticked =
      text.slice(0, match.index) + match[1] + '[x]' + match[2] + match[3] + text.slice(match.index + match[0].length);
    fs.writeFileSync(file, ticked);
    const done = (ticked.match(DONE_ALL) || []).length;
    const open = (ticked.match(OPEN_ALL) || []).length;
    return { text: match[3].trim(), position: done, total: done + open };
  } catch {
    return null;
  }
}

module.exports = { takeNext, FILE };
