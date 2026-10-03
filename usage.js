// Reads the Claude plan usage (the same numbers /usage shows) by asking the Claude Code CLI.
// It starts the CLI in print mode, sends one `get_usage` control request and exits: no prompt is
// sent, no tokens are spent, hooks are off and nothing is saved. Any failure resolves to null so
// the caller can hide the meter instead of showing a wrong number.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TIMEOUT_MS = 20000;
const ARGS = [
  '-p',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose',
  '--no-session-persistence',
  '--strict-mcp-config',
  '--settings', '{"disableAllHooks":true}',
];
const REQUEST = JSON.stringify({ type: 'control_request', request_id: 'usage', request: { subtype: 'get_usage' } });

function findClaude() {
  const home = os.homedir();
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const candidates = [path.join(home, '.local', 'bin', exe)];
  if (process.platform === 'win32' && process.env.APPDATA) {
    candidates.unshift(path.join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', exe));
  } else {
    candidates.push('/usr/local/bin/claude', '/opt/homebrew/bin/claude');
  }
  // the VS Code extension ships its own copy; newest version last
  try {
    const extensions = path.join(home, '.vscode', 'extensions');
    const bundled = fs.readdirSync(extensions)
      .filter((name) => name.startsWith('anthropic.claude-code-'))
      .sort()
      .reverse()
      .map((name) => path.join(extensions, name, 'resources', 'native-binary', exe));
    candidates.push(...bundled);
  } catch {
    // no VS Code extension
  }
  return candidates.find((file) => fs.existsSync(file)) || null;
}

function parse(message) {
  const response = message.response;
  const data = response && response.response;
  if (!response || response.subtype !== 'success' || !data) return null;
  if (!data.rate_limits_available || !data.rate_limits) return null;

  const session = readWindow(data.rate_limits.five_hour);
  if (!session) return null;
  return { ...session, week: readWindow(data.rate_limits.seven_day) };
}

function readWindow(window) {
  if (!window || window.utilization == null) return { percent: 0, resetsAt: null }; // no window open yet
  const percent = Number(window.utilization);
  if (!Number.isFinite(percent) || percent < 0) return null;
  const resetsAt = Date.parse(window.resets_at);
  return { percent: Math.min(100, percent), resetsAt: Number.isFinite(resetsAt) ? resetsAt : null };
}

// Resolves to { percent, resetsAt, week: { percent, resetsAt } | null } — the 5-hour window and the
// weekly one — or null if usage can't be read.
function fetchUsage(cwd) {
  return new Promise((resolve) => {
    const claude = findClaude();
    if (!claude) return resolve(null);

    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;

    let child;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.stdin.end();
      } catch {
        // already closed
      }
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish(null);
      try {
        child.kill();
      } catch {
        // already gone
      }
    }, TIMEOUT_MS);

    try {
      child = spawn(claude, ARGS, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      return finish(null);
    }

    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.type === 'control_response') finish(parse(message));
      }
    });
    child.on('error', () => finish(null));
    child.on('exit', () => finish(null));
    child.stdin.on('error', () => {});
    child.stdin.write(REQUEST + '\n');
  });
}

module.exports = { fetchUsage, findClaude };
