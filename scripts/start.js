// Dev launcher. Terminals inside VS Code set ELECTRON_RUN_AS_NODE, which makes Electron
// behave like plain Node and crash on startup, so clear it before launching.
const { spawn } = require('child_process');
const path = require('path');
const electron = require('electron'); // in plain Node this is the path to the Electron binary

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [path.join(__dirname, '..')], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
