// Adds or removes the claude-face hooks in the user-level Claude Code settings (~/.claude/settings.json).
// Always backs the file up first and merges: nothing already there is changed or removed.
const fs = require('fs');
const os = require('os');
const path = require('path');

// event -> seconds Claude Code waits for the hook. Only PermissionRequest may take long: it can
// hold a permission prompt while you answer it from your phone.
const EVENTS = {
  UserPromptSubmit: 5,
  PreToolUse: 5,
  Stop: 5,
  StopFailure: 5,
  Notification: 5,
  SessionEnd: 5,
  PermissionRequest: 310,
};
const HOOK_NAME = 'claude-face-hook.js';

function locations(home = os.homedir()) {
  const claudeDir = path.join(home, '.claude');
  return {
    claudeDir,
    settingsPath: path.join(claudeDir, 'settings.json'),
    // the hook is copied next to Claude Code's settings so it keeps working if the app moves
    hookPath: path.join(claudeDir, 'hooks', HOOK_NAME),
  };
}

const slash = (p) => p.replace(/\\/g, '/');
const isOurs = (hook) => typeof hook.command === 'string' && hook.command.includes(HOOK_NAME);

// runner: { exe } for Node.js, or { exe, electronAsNode: true } to run the hook with the app's own
// executable when Node.js isn't installed (Claude Code runs hook commands in a bash shell).
function commandFor(runner, hookPath) {
  const prefix = runner.electronAsNode ? 'ELECTRON_RUN_AS_NODE=1 ' : '';
  return `${prefix}"${slash(runner.exe)}" "${slash(hookPath)}"`;
}

function read(settingsPath) {
  const original = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : null;
  return { original, settings: original ? JSON.parse(original) : {} };
}

function backup(settingsPath, original) {
  if (original === null) return null;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const backupPath = `${settingsPath}.before-claude-face-${stamp}`;
  fs.writeFileSync(backupPath, original);
  return backupPath;
}

// keeps the file's own line endings and final newline so a diff shows only the real change
function write(settingsPath, original, settings) {
  let text = JSON.stringify(settings, null, 2);
  if (original === null || original.endsWith('\n')) text += '\n';
  if (original && original.includes('\r\n')) text = text.replace(/\n/g, '\r\n');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, text);
}

function isInstalled(home) {
  try {
    const { settings } = read(locations(home).settingsPath);
    const all = settings.hooks || {};
    return Object.keys(EVENTS).every((event) =>
      Array.isArray(all[event]) && all[event].some((group) => Array.isArray(group.hooks) && group.hooks.some(isOurs)));
  } catch {
    return false;
  }
}

// Safe to run again: events that already have the hook are left alone.
function install({ runner, hookSource, home }) {
  const { settingsPath, hookPath } = locations(home);
  const { original, settings } = read(settingsPath); // throws on a broken settings file: nothing is touched
  fs.mkdirSync(path.dirname(hookPath), { recursive: true });
  fs.writeFileSync(hookPath, fs.readFileSync(hookSource)); // works from inside the packaged app too
  const backupPath = backup(settingsPath, original);
  const command = commandFor(runner, hookPath);
  const changed = [];
  settings.hooks = settings.hooks || {};
  for (const [event, timeout] of Object.entries(EVENTS)) {
    const groups = (settings.hooks[event] = settings.hooks[event] || []);
    if (groups.some((group) => Array.isArray(group.hooks) && group.hooks.some(isOurs))) continue;
    groups.push({ hooks: [{ type: 'command', command, timeout }] });
    changed.push(event);
  }
  write(settingsPath, original, settings);
  return { settingsPath, backupPath, hookPath, changed };
}

// Takes out only the claude-face hooks, and the copied hook script.
function remove({ home } = {}) {
  const { settingsPath, hookPath } = locations(home);
  const { original, settings } = read(settingsPath);
  const backupPath = backup(settingsPath, original);
  const changed = [];
  for (const event of Object.keys(settings.hooks || {})) {
    const groups = settings.hooks[event];
    if (!Array.isArray(groups)) continue;
    const kept = [];
    for (const group of groups) {
      if (!Array.isArray(group.hooks) || !group.hooks.some(isOurs)) {
        kept.push(group);
        continue;
      }
      changed.push(event);
      const others = group.hooks.filter((hook) => !isOurs(hook));
      if (others.length) kept.push({ ...group, hooks: others });
    }
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (fs.existsSync(hookPath)) fs.unlinkSync(hookPath);
  if (original !== null) write(settingsPath, original, settings);
  return { settingsPath, backupPath, changed };
}

module.exports = { install, remove, isInstalled, commandFor, EVENTS, HOOK_NAME };
