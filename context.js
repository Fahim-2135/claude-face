// Estimates how full a session's context is from the end of its transcript: the last main-thread
// reply records how many tokens were sent to the model, which is the size of the context.
const fs = require('fs');

const TAIL_BYTES = 512 * 1024;
const SMALL_WINDOW = 200000;
const BIG_WINDOW = 1000000;

// Returns { tokens, model } or null.
function readContext(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    const first = length < size ? 1 : 0; // the first line of a partial read is cut off
    for (let i = lines.length - 1; i >= first; i--) {
      if (!lines[i].includes('"usage"')) continue;
      let entry;
      try {
        entry = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      const message = entry.message;
      if (entry.type !== 'assistant' || entry.isSidechain || !message || !message.usage) continue;
      if (!message.model || message.model.startsWith('<')) continue;
      const u = message.usage;
      const tokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      return { tokens, model: message.model };
    }
  } catch {
    // unreadable transcript: no estimate
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  return null;
}

// Claude Code doesn't publish the window size per model. A model that has been seen holding more
// than 200k tokens must have the 1M window; until then the smaller one is assumed.
function windowFor(model, bigModels) {
  return bigModels.includes(model) ? BIG_WINDOW : SMALL_WINDOW;
}

module.exports = { readContext, windowFor, SMALL_WINDOW };
