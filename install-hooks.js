#!/usr/bin/env node
// Command-line way to add the claude-face hooks to Claude Code (the app can also do it from its tray menu).
//   node install-hooks.js            install (safe to run twice)
//   node install-hooks.js --remove   take the claude-face hooks back out
const path = require('path');
const hooks = require('./hooks');

const removing = process.argv.includes('--remove');
const result = removing
  ? hooks.remove()
  : hooks.install({ runner: { exe: process.execPath }, hookSource: path.join(__dirname, 'hook.js') });

console.log(removing ? 'Removed claude-face hooks.' : 'Installed claude-face hooks.');
console.log(`  settings: ${result.settingsPath}`);
console.log(`  backup:   ${result.backupPath || '(no settings file existed before)'}`);
if (!removing) console.log(`  hook:     ${result.hookPath}`);
console.log(`  events:   ${result.changed.length ? result.changed.join(', ') : '(nothing to change)'}`);
