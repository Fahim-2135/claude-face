const {
  app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, clipboard, powerMonitor, dialog, Notification,
} = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { dotPNG } = require('./png');
const { fetchUsage, findClaude } = require('./usage');
const { newTopic, sendPing, listen } = require('./ping');
const { takeNext, FILE: QUEUE_FILE } = require('./queue');
const { readContext, windowFor, SMALL_WINDOW } = require('./context');
const { focusWindow } = require('./focus');
const hooks = require('./hooks');
// tests can point the hook setup at a throwaway home folder instead of the real ~/.claude
const HOOKS_HOME = process.env.CLAUDE_FACE_DEBUG ? process.env.CLAUDE_FACE_HOOKS_HOME : undefined;

const HOST = '127.0.0.1';
const PORT = 7777;

const PRIORITY = { idle: 0, done: 1, working: 2, asking: 3 };
const COLORS = { idle: '#8b93a1', working: '#4da3ff', done: '#4cd787', asking: '#ff9f43' };

const DONE_TO_IDLE_MS = Number(process.env.CLAUDE_FACE_DONE_MS) || 5 * 60 * 1000;
const STALE_MS = 30 * 60 * 1000;
const SWEEP_MS = 10 * 1000;

const USAGE_ACTIVE_MS = 60 * 1000; // refresh rate while any Claude session is open
const USAGE_QUIET_MS = 5 * 60 * 1000; // and while none is
const USAGE_STALE_MS = 12 * 60 * 1000; // older readings are hidden, not shown

const ASK_DELAYS_MIN = [1, 2, 5];
const ASK_DELAY_TEST_MS = Number(process.env.CLAUDE_FACE_ASK_MS) || 0;
const LONG_TASK_MS = Number(process.env.CLAUDE_FACE_TASK_MS) || 5 * 60 * 1000;

const AWAY_S = 45; // no mouse or keyboard for this long counts as away from the PC
const BACK_S = 5;
const APPROVE_WAIT_MS = 280 * 1000; // the hook itself gives up shortly after
const CONTEXT_EVERY_MS = 20 * 1000;
const CONTEXT_WARN = 80; // percent
const RESUME_AFTER_RESET_MS = Number(process.env.CLAUDE_FACE_RESUME_MS) || 90 * 1000;
const LIMIT_PERCENT = 95; // a window at or above this is taken to be the one that ran out
const RESUME_PROMPT =
  'Your usage limit has reset. Continue the task you were working on when the limit stopped you. ' +
  'If it was already finished, say so and stop.';

const MIN_SIZE = 60;
const MAX_SIZE = 300;
const DEFAULT_SIZE = 160;
const MINI_DOT = 42; // the most important face, in a small round badge
const MINI_WINDOW = 48; // Windows won't make a window as small as 24px, so the dot sits in a larger see-through one
const MARGIN = 20;

const DEBUG = !!process.env.CLAUDE_FACE_DEBUG;

// ---------- the faces: the five heads on the widget ----------
// The front face is the most urgent session: one that needs you, then one that has just finished
// (for a moment, so its happy pop shows), then one at work. Every chat has a face of its own, so
// the number of faces awake is the number of chats at work: Crew's agents wear their own faces;
// your own chats each get one picked at random (or, if chosen in the tray, every chat wears the
// same Claude orange or VS Code face). The rest of the five doze: Crew agents seen lately, then
// the five from Crew's icon.
const YOUR_FACES = ['random', 'you', 'vscode'];
// The 25 faces (Crew's icons), in the order Crew lists them.
const FACES = [
  'crown', 'bulb', 'antenna', 'sprout', 'heart', 'hardhat', 'gradcap', 'headphones', 'beanie',
  'cap', 'halo', 'bow', 'flowers', 'star', 'tophat', 'wizard', 'chef', 'cat', 'bunny', 'glasses',
  'headset', 'bandana', 'party', 'cowboy', 'propeller',
];
const JUST_DONE_MS = 8 * 1000;
const RESTING = ['crown', 'headset', 'bandana', 'tophat', 'antenna'];
const MAX_FACES = 5;
const pingLog = []; // what was sent, for the debug endpoint
const resumeLog = [];
let usageFake = false;

let win = null;
let tray = null;
let shown = 'idle';
const sessions = new Map(); // session_id -> { state, since, lastSeen }
const trayIcons = {};

// ---------- saved settings ----------

const configPath = path.join(app.getPath('userData'), 'config.json');
const config = {
  x: null,
  y: null,
  size: DEFAULT_SIZE,
  mini: false,
  sound: true,
  loginSet: false,
  usageMeter: true,
  ping: true,
  askDelayMin: 2,
  ntfyTopic: null,
  replyTopic: null, // where the phone's Allow / Deny taps arrive
  phoneApprove: true,
  autoResume: false,
  taskQueue: true,
  contextWarn: true,
  bigContextModels: [], // models seen holding more than 200k tokens
  limited: [], // sessions stopped by the usage limit: { id, cwd, at }
  crewOnly: false, // show only Crew's agents, not every Claude Code session
  yourFace: 'random', // your own chats: 'random' (each its own face), or every chat the same: 'you' (Claude orange) or 'vscode'
  faceModeChosen: false, // whether yourFace was picked in the tray (else the default applies)
  crewSeen: [], // Crew agents seen lately, newest first: { agent, icon, title } (they doze in the corners)
};

function loadConfig() {
  try {
    Object.assign(config, JSON.parse(fs.readFileSync(configPath, 'utf8')));
  } catch {
    // first launch or unreadable file: keep defaults
  }
  config.size = clamp(Number(config.size) || DEFAULT_SIZE, MIN_SIZE, MAX_SIZE);
  if (!ASK_DELAYS_MIN.includes(config.askDelayMin)) config.askDelayMin = 2;
  if (!Array.isArray(config.bigContextModels)) config.bigContextModels = [];
  if (!Array.isArray(config.limited)) config.limited = [];
  if (!Array.isArray(config.crewSeen)) config.crewSeen = [];
  delete config.projectsSeen; // from a test build that gave each folder a face
  if (!YOUR_FACES.includes(config.yourFace)) config.yourFace = 'random';
  // 1.3.x saved 'you' for everyone; only a choice made in the tray is kept.
  if (config.yourFace === 'you' && !config.faceModeChosen) config.yourFace = 'random';
  let changed = false;
  for (const key of ['ntfyTopic', 'replyTopic']) {
    if (typeof config[key] !== 'string' || !/^[-_A-Za-z0-9]{32,64}$/.test(config[key])) {
      config[key] = newTopic();
      changed = true;
    }
  }
  if (changed) writeConfig();
}

let saveTimer = null;
function saveConfig() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeConfig, 300);
}
function writeConfig() {
  clearTimeout(saveTimer);
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  } catch {
    // settings just won't be remembered
  }
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

// ---------- window placement ----------

function windowSize() {
  return config.mini ? MINI_WINDOW : config.size;
}

// In mini mode only the dot (bottom-right corner) is part of the window; the rest lets clicks through.
function applyShape() {
  if (typeof win.setShape !== 'function') return;
  const offset = MINI_WINDOW - MINI_DOT;
  win.setShape(config.mini ? [{ x: offset, y: offset, width: MINI_DOT, height: MINI_DOT }] : []);
}

function bottomRight(size) {
  const area = screen.getPrimaryDisplay().workArea;
  return { x: area.x + area.width - size - MARGIN, y: area.y + area.height - size - MARGIN };
}

function isOnScreen(x, y, size) {
  const cx = x + size / 2;
  const cy = y + size / 2;
  return screen.getAllDisplays().some(({ workArea: a }) =>
    cx >= a.x && cx <= a.x + a.width && cy >= a.y && cy <= a.y + a.height);
}

function keepInside(x, y, size) {
  const area = screen.getDisplayNearestPoint({ x: Math.round(x + size / 2), y: Math.round(y + size / 2) }).workArea;
  return {
    x: clamp(x, area.x, area.x + area.width - size),
    y: clamp(y, area.y, area.y + area.height - size),
  };
}

function place(x, y, size) {
  win.setBounds({ x: Math.round(x), y: Math.round(y), width: size, height: size });
  config.x = Math.round(x);
  config.y = Math.round(y);
  saveConfig();
}

function resetPosition() {
  const size = windowSize();
  const pos = bottomRight(size);
  place(pos.x, pos.y, size);
  win.showInactive();
}

function ensureOnScreen() {
  if (!isOnScreen(config.x, config.y, windowSize())) resetPosition();
}

function createWindow() {
  const size = windowSize();
  let pos = { x: config.x, y: config.y };
  if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !isOnScreen(pos.x, pos.y, size)) {
    pos = bottomRight(size);
  }

  win = new BrowserWindow({
    x: pos.x,
    y: pos.y,
    width: size,
    height: size,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false, // chimes must still play while hidden in the tray
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setMenu(null);
  config.x = pos.x;
  config.y = pos.y;
  applyShape();
  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => win.showInactive());
  win.on('show', buildTrayMenu);
  win.on('hide', buildTrayMenu);
}

function toggleVisible() {
  if (win.isVisible()) {
    win.hide();
  } else {
    ensureOnScreen();
    win.showInactive();
  }
}

function setMini(on) {
  if (config.mini === on) return;
  const before = windowSize();
  config.mini = on;
  const size = windowSize();
  // keep the bottom-right corner where it was, so the dot sits in the face's corner
  const pos = keepInside(config.x + before - size, config.y + before - size, size);
  if (!on) applyShape();
  place(pos.x, pos.y, size);
  if (on) applyShape();
  sendUpdate();
  buildTrayMenu();
}

// ---------- sessions ----------

function aggregate() {
  let best = 'idle';
  for (const s of sessions.values()) {
    if (PRIORITY[s.state] > PRIORITY[best]) best = s.state;
  }
  return best;
}

// meta: { cwd, transcript } from the hook; quiet = don't count this "done" towards the finished ping
function report(sessionId, state, meta = {}) {
  const now = Date.now();
  if (state === 'end') {
    sessions.delete(sessionId);
    return refresh();
  }

  let s = sessions.get(sessionId);
  if (!s) {
    s = { state: null, since: now, lastSeen: now, taskStart: null };
    sessions.set(sessionId, s);
  }
  if (s.state !== state) {
    // a task runs from the first "working" until "done"; pauses for questions are part of it
    const wasBusy = s.state === 'working' || s.state === 'asking';
    const isBusy = state === 'working' || state === 'asking';
    if (state === 'done') {
      if (wasBusy && !meta.quiet) finishedTaskMs = Math.max(finishedTaskMs, now - s.taskStart);
      refreshUsage();
    }
    s.taskStart = isBusy ? (wasBusy ? s.taskStart : now) : null;
    s.state = state;
    s.since = now;
  }
  s.lastSeen = now;
  if (meta.cwd) s.cwd = meta.cwd;
  if (meta.transcript) s.transcript = meta.transcript;
  if (meta.crew) {
    s.crew = meta.crew;
    rememberAgent(meta.crew);
  }
  if (state === 'done') setTimeout(refresh, JUST_DONE_MS + 50); // the front seat passes on
  if (state === 'working') forgetLimited(sessionId); // it is running again, by hand or by auto-resume
  readSessionContext(s, now);
  refresh();
}

/** Keep the agents seen lately (newest first), so the corners show your own team dozing. */
function rememberAgent({ agent, icon, title }) {
  const before = JSON.stringify(config.crewSeen);
  config.crewSeen = [{ agent, icon: icon || null, title: title || agent }]
    .concat(config.crewSeen.filter((a) => a.agent !== agent))
    .slice(0, 12);
  if (JSON.stringify(config.crewSeen) !== before) saveConfig();
}

/**
 * A chat's own face, picked at random the first time it is drawn and kept while the chat is open.
 * It avoids faces other chats and Crew agents are wearing, so no two look alike.
 */
function chatFace(s) {
  if (s.face) return s.face;
  const taken = new Set();
  for (const other of sessions.values()) {
    if (other.face) taken.add(other.face);
    if (other.crew && other.crew.icon) taken.add(other.crew.icon);
  }
  const free = FACES.filter((icon) => !taken.has(icon));
  const pool = free.length ? free : FACES;
  s.face = pool[Math.floor(Math.random() * pool.length)];
  return s.face;
}

/** The faces to draw, front one first: { key, kind, icon, title, state }. */
function lineup() {
  const now = Date.now();
  const rank = (s) =>
    s.state === 'asking' ? 4 : s.state === 'done' && now - s.since < JUST_DONE_MS ? 3 : s.state === 'working' ? 2 : s.state === 'done' ? 1 : 0;
  const best = new Map();
  for (const [id, s] of sessions) {
    // A Crew agent is one face however many runs it has; each of your chats is its own face,
    // with no name under it.
    const face = s.crew
      ? { key: 'crew:' + s.crew.agent, kind: 'crew', icon: s.crew.icon || null, title: s.crew.title || s.crew.agent }
      : { key: 'chat:' + id, kind: 'chat', icon: config.yourFace === 'random' ? chatFace(s) : config.yourFace, title: '' };
    const entry = { ...face, state: s.state, rank: rank(s), since: s.since };
    const prev = best.get(face.key);
    if (!prev || entry.rank > prev.rank || (entry.rank === prev.rank && entry.since < prev.since)) best.set(face.key, entry);
  }
  // The busiest first; among equals the one that started first keeps its place.
  const faces = [...best.values()].sort((a, b) => b.rank - a.rank || a.since - b.since);
  for (const a of config.crewSeen) {
    if (faces.length >= MAX_FACES) break;
    if (!best.has('crew:' + a.agent)) faces.push({ key: 'crew:' + a.agent, kind: 'crew', icon: a.icon, title: a.title, state: 'idle' });
  }
  for (const icon of RESTING.concat(FACES)) {
    if (faces.length >= MAX_FACES) break;
    if (!faces.some((x) => x.icon === icon)) faces.push({ key: 'rest:' + icon, kind: 'rest', icon, title: '', state: 'idle' });
  }
  return faces.slice(0, MAX_FACES).map(({ key, kind, icon, title, state }) => ({ key, kind, icon, title, state }));
}

function sweep() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastSeen > STALE_MS) sessions.delete(id);
    else if (s.state === 'done' && now - s.since > DONE_TO_IDLE_MS) {
      s.state = 'idle';
      s.since = now;
    }
  }
  refresh();
}

let shownFaces = '';
function refresh() {
  const next = aggregate();
  const context = currentContext();
  const faces = JSON.stringify(lineup());
  if (faces !== shownFaces) {
    shownFaces = faces;
    if (next === shown && context === shownContext) sendUpdate();
  }
  if (next !== shown) {
    shown = next;
    shownSince = Date.now();
    shownContext = context;
    if (tray) tray.setImage(trayIcon(shown));
    onShownChange();
    sendUpdate();
  } else if (context !== shownContext) {
    shownContext = context;
    sendUpdate();
  }
  updateTooltip();
}

function updateTooltip() {
  if (!tray) return;
  const usage = currentUsage();
  tray.setToolTip(
    `Claude Code: ${shown}` +
    (sessions.size > 1 ? ` (${sessions.size} sessions)` : '') +
    (usage ? ` · 5h ${Math.round(usage.percent)}%` : '') +
    (usage && usage.week ? ` · week ${Math.round(usage.week.percent)}%` : '') +
    (shownContext ? ` · context ${shownContext}% full` : '')
  );
}

function sendUpdate() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('update', {
      state: shown,
      mini: config.mini,
      sound: config.sound,
      usage: currentUsage(),
      context: shownContext,
      faces: lineup(),
    });
  }
}

// ---------- context warning ----------

let shownContext = null; // percent of the fullest session, or null while nothing is near full

function readSessionContext(s, now) {
  if (!config.contextWarn || !s.transcript || now - (s.contextAt || 0) < CONTEXT_EVERY_MS) return;
  s.contextAt = now;
  const reading = readContext(s.transcript);
  if (!reading) return;
  if (reading.tokens > SMALL_WINDOW && !config.bigContextModels.includes(reading.model)) {
    config.bigContextModels.push(reading.model);
    saveConfig();
  }
  s.context = Math.min(100, Math.round((reading.tokens / windowFor(reading.model, config.bigContextModels)) * 100));
}

function currentContext() {
  if (!config.contextWarn) return null;
  let fullest = 0;
  for (const s of sessions.values()) fullest = Math.max(fullest, s.context || 0);
  return fullest >= CONTEXT_WARN ? fullest : null;
}

// ---------- click the face: bring the session that needs you to the front ----------

const FOCUS_ORDER = { asking: 3, done: 2, working: 1, idle: 0 };

function focusNeediestSession() {
  let best = null;
  for (const s of sessions.values()) {
    if (!s.cwd) continue;
    if (!best || FOCUS_ORDER[s.state] > FOCUS_ORDER[best.state] ||
      (FOCUS_ORDER[s.state] === FOCUS_ORDER[best.state] && s.since > best.since)) best = s;
  }
  if (!best) return;
  if (best.crew) return openInCrew(best.crew);
  focusWindow(best.cwd);
}

// A Crew agent has no terminal of its own: show it in the Crew window instead.
function openInCrew({ agent, cli, node }) {
  try {
    const child = spawn(node, [cli, 'open', agent], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // Crew isn't there any more: nothing to open
  }
}

// ---------- task queue ----------

// Called when a session stops. Returns the text to hand back to Claude, or null to let it stop.
function nextQueuedTask(sessionId, meta) {
  if (!config.taskQueue || !meta.cwd) return null;
  const s = sessions.get(sessionId);
  const finished = s && s.queue;
  const task = takeNext(meta.cwd);
  if (finished) {
    ping(
      `Claude finished task ${finished.position} of ${finished.total}`,
      task ? 'Starting the next one.' : 'That was the last one in the queue.',
      'default'
    );
  }
  if (!task) {
    report(sessionId, 'done', { ...meta, quiet: !!finished });
    delete sessions.get(sessionId).queue;
    return null;
  }
  report(sessionId, 'working', meta);
  sessions.get(sessionId).queue = task;
  return (
    `Next task from ${QUEUE_FILE} (${task.position} of ${task.total}):\n${task.text}\n\n` +
    'When it is finished, stop. The following task will be given to you automatically.'
  );
}

// ---------- approve from the phone ----------

const approvals = new Map(); // nonce -> finish(decision)
let stopListening = null;

function idleSeconds() {
  if (DEBUG && process.env.CLAUDE_FACE_AWAY) return 9999;
  return powerMonitor.getSystemIdleTime();
}

function onPhoneReply(text) {
  const match = /^(allow|deny):([0-9a-f]{32})$/.exec(text.trim());
  const finish = match && approvals.get(match[2]);
  if (finish) finish(match[1]);
}

// Holds the hook's request open until the phone answers, you come back to the PC, or time runs out.
function askPhone(data, res) {
  if (!config.ping || !config.phoneApprove || idleSeconds() < AWAY_S) return json(res, 200, { decision: null });

  const sessionId = data.session_id;
  const meta = { cwd: data.cwd, transcript: data.transcript };
  const nonce = crypto.randomBytes(16).toString('hex');

  const finish = (decision) => {
    if (!approvals.delete(nonce)) return;
    clearTimeout(timeout);
    clearInterval(watch);
    if (!approvals.size && stopListening) {
      stopListening();
      stopListening = null;
    }
    if (!res.writableEnded) json(res, 200, { decision });
    if (decision) report(sessionId, 'working', meta);
  };
  const timeout = setTimeout(() => finish(null), APPROVE_WAIT_MS);
  const watch = setInterval(() => {
    if (idleSeconds() < BACK_S) finish(null); // you're back: the normal prompt takes over
  }, 2000);
  res.on('close', () => finish(null));
  approvals.set(nonce, finish);
  if (!stopListening) stopListening = listen(config.replyTopic, onPhoneReply);

  const tool = String(data.tool || 'tool').slice(0, 60);
  const detail = String(data.detail || '').slice(0, 80);
  const more = Number(data.more) > 0 ? ` … (+${Number(data.more)} more characters not shown)` : '';
  const where = meta.cwd ? `\nin ${path.basename(meta.cwd)}` : '';
  const button = (label, word) => ({
    action: 'http',
    label,
    url: `https://ntfy.sh/${config.replyTopic}`,
    method: 'POST',
    body: `${word}:${nonce}`,
    clear: true,
  });
  const note = {
    title: 'Claude asks permission',
    message: `${tool}${detail ? ': ' + detail : ''}${more}${where}`,
    priority: 'high',
    actions: [button('Allow', 'allow'), button('Deny', 'deny')],
  };
  if (DEBUG) pingLog.push({ ...note, at: Date.now() });
  sendPing(config.ntfyTopic, note);

  report(sessionId, 'asking', meta);
  askPinged = true; // this notification stands in for the "Claude needs you" ping
  clearTimeout(askTimer);
}

// ---------- auto-resume after the usage limit ----------

let resumeTimer = null;

function clock(time) {
  const date = new Date(time);
  const sameDay = date.toDateString() === new Date().toDateString();
  const hour = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return sameDay ? hour : `${date.toLocaleDateString([], { weekday: 'short' })} ${hour}`;
}

function forgetLimited(sessionId) {
  if (!config.limited.some((entry) => entry.id === sessionId)) return;
  config.limited = config.limited.filter((entry) => entry.id !== sessionId);
  saveConfig();
  scheduleResume();
}

async function onLimitHit(sessionId, cwd) {
  const reading = usageFake ? usage : await fetchUsage(app.getPath('userData'));
  let resetsAt = null;
  if (reading && reading.percent >= LIMIT_PERCENT) resetsAt = reading.resetsAt;
  else if (reading && reading.week && reading.week.percent >= LIMIT_PERCENT) resetsAt = reading.week.resetsAt;

  if (config.autoResume && resetsAt && cwd) {
    config.limited = config.limited.filter((entry) => entry.id !== sessionId);
    config.limited.push({ id: sessionId, cwd, at: resetsAt + RESUME_AFTER_RESET_MS });
    writeConfig();
    scheduleResume();
    ping('Claude hit your usage limit', `It will continue by itself at ${clock(resetsAt)}.`, 'default');
  } else {
    ping('Claude hit your usage limit', resetsAt ? `The limit resets at ${clock(resetsAt)}.` : 'Reset time unknown.', 'default');
  }
}

function scheduleResume() {
  clearTimeout(resumeTimer);
  if (!config.limited.length) return;
  const next = Math.min(...config.limited.map((entry) => entry.at));
  resumeTimer = setTimeout(resumeDue, clamp(next - Date.now(), 0, 2 ** 31 - 1));
}

function resumeDue() {
  const now = Date.now();
  const due = config.limited.filter((entry) => entry.at <= now);
  config.limited = config.limited.filter((entry) => entry.at > now);
  writeConfig();
  scheduleResume();
  if (!config.autoResume) return;
  for (const entry of due) resumeSession(entry);
}

// Continues the session without a window: its answers land in the session's history, and
// anything that needs permission goes to the phone (or is refused if nobody answers).
function resumeSession({ id, cwd }) {
  const claude = findClaude();
  if (!claude || !fs.existsSync(cwd)) return;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const child = spawn(claude, ['--resume', id, '-p', RESUME_PROMPT], { cwd, env, windowsHide: true, stdio: 'ignore' });
    child.on('error', () => {});
    if (DEBUG) resumeLog.push({ id, cwd, at: Date.now() });
    ping('Claude continued after the limit reset', `Working again in ${path.basename(cwd)}.`, 'default');
  } catch {
    // could not start Claude Code: leave it for the user
  }
}

// ---------- usage meter ----------

let usage = null; // { percent, resetsAt, at }
let usageBusy = false;
let usageQueued = false;
let usageLastTry = 0;

function currentUsage() {
  if (!config.usageMeter || !usage) return null;
  const now = Date.now();
  if (now - usage.at > USAGE_STALE_MS) return null;
  if (usage.resetsAt && now > usage.resetsAt) return null; // the window has reset since this reading
  const week = usage.week && !(usage.week.resetsAt && now > usage.week.resetsAt) ? usage.week : null;
  return { percent: usage.percent, resetsAt: usage.resetsAt, week };
}

async function refreshUsage() {
  if (!config.usageMeter) return;
  if (usageBusy) {
    usageQueued = true;
    return;
  }
  usageBusy = true;
  usageLastTry = Date.now();
  const reading = await fetchUsage(app.getPath('userData'));
  usageBusy = false;
  if (!usageFake) usage = reading && { ...reading, at: Date.now() };
  sendUpdate();
  updateTooltip();
  if (usageQueued) {
    usageQueued = false;
    refreshUsage();
  }
}

function usageTick() {
  const sinceTry = Date.now() - usageLastTry;
  const windowReset = !!usage && !!usage.resetsAt && Date.now() > usage.resetsAt;
  if (sessions.size > 0 || windowReset || sinceTry >= USAGE_QUIET_MS - 1000) refreshUsage();
  else sendUpdate(); // lets a stale reading disappear
}

// ---------- phone ping ----------

let shownSince = Date.now();
let finishedTaskMs = 0; // longest task finished since the face last showed done or idle
let askTimer = null;
let askPinged = false;

function askDelayMs() {
  return ASK_DELAY_TEST_MS || config.askDelayMin * 60 * 1000;
}

function minutes(ms) {
  const total = Math.max(1, Math.round(ms / 60000));
  if (total < 90) return `${total} minute${total === 1 ? '' : 's'}`;
  return `${Math.floor(total / 60)} h ${total % 60} min`;
}

function ping(title, message, priority) {
  if (!config.ping) return;
  if (DEBUG) pingLog.push({ title, message, priority, at: Date.now() });
  sendPing(config.ntfyTopic, { title, message, priority });
}

function scheduleAskPing() {
  clearTimeout(askTimer);
  if (shown !== 'asking' || askPinged) return;
  const wait = Math.max(0, askDelayMs() - (Date.now() - shownSince));
  askTimer = setTimeout(() => {
    if (shown !== 'asking' || askPinged) return;
    askPinged = true;
    ping('Claude needs you', `Waiting for your answer for ${minutes(Date.now() - shownSince)}.`, 'high');
  }, wait);
}

function onShownChange() {
  askPinged = false;
  scheduleAskPing();
  if (shown === 'done' && finishedTaskMs >= LONG_TASK_MS) {
    ping('Claude finished', `The task ran for about ${minutes(finishedTaskMs)}.`, 'default');
  }
  if (shown === 'done' || shown === 'idle') finishedTaskMs = 0;
}

// ---------- local server for the hooks ----------

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
    Connection: 'close',
  });
  res.end(text);
}

function handle(req, res) {
  if (req.method === 'GET' && req.url === '/state') {
    return json(res, 200, { state: shown, sessions: Object.fromEntries(sessions), usage: currentUsage() });
  }

  if (DEBUG && req.method === 'GET' && req.url === '/debug/pings') {
    return json(res, 200, pingLog);
  }

  if (DEBUG && req.method === 'GET' && req.url === '/debug/test-ping') {
    testPing();
    return json(res, 200, { ok: true });
  }

  // /debug/usage?85,40 shows a made-up reading (5-hour, week); /debug/usage?off goes back to real ones
  if (DEBUG && req.method === 'GET' && req.url.startsWith('/debug/usage?')) {
    const value = req.url.split('?')[1];
    usageFake = value !== 'off';
    if (usageFake) {
      const [session, week, resetInSeconds] = value.split(',').map(Number);
      usage = {
        percent: session,
        resetsAt: Date.now() + (resetInSeconds ? resetInSeconds * 1000 : 134 * 60 * 1000),
        week: Number.isFinite(week) ? { percent: week, resetsAt: Date.now() + 147 * 60 * 60 * 1000 } : null,
        at: Date.now(),
      };
    }
    else refreshUsage();
    sendUpdate();
    return json(res, 200, { usage: currentUsage() });
  }

  if (DEBUG && req.method === 'GET' && req.url === '/debug/shot') {
    return win.webContents.capturePage().then((image) => {
      res.writeHead(200, { 'Content-Type': 'image/png', Connection: 'close' });
      res.end(image.toPNG());
    }, () => json(res, 500, { error: 'capture failed' }));
  }

  if (DEBUG && req.method === 'GET' && req.url === '/debug/mini') {
    setMini(!config.mini);
    return json(res, 200, { mini: config.mini, bounds: win.getBounds() });
  }

  if (DEBUG && req.method === 'GET' && req.url === '/debug/resumes') {
    return json(res, 200, { started: resumeLog, waiting: config.limited });
  }

  // /debug/set?autoResume=1 flips an on/off setting for a test
  if (DEBUG && req.method === 'GET' && req.url.startsWith('/debug/set?')) {
    const [key, value] = req.url.split('?')[1].split('=');
    if (typeof config[key] === 'boolean') config[key] = value === '1';
    saveConfig();
    return json(res, 200, { [key]: config[key] });
  }

  if (DEBUG && req.method === 'GET' && req.url === '/debug/focus') {
    focusNeediestSession();
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && req.url === '/state') {
    return readBody(req, res, (data) => {
      const { session_id: sessionId, state } = data;
      if (state !== 'end' && !(state in PRIORITY)) {
        return json(res, 400, { error: 'state must be idle, working, done, asking or end' });
      }
      const meta = { cwd: text(data.cwd), transcript: text(data.transcript), crew: crewOf(data.crew) };
      // "Only Crew agents": every other Claude Code session is left out.
      if (config.crewOnly && !meta.crew) return json(res, 200, { ok: true, state: shown });

      // a finished turn may be handed the next task from the queue instead of stopping
      if (state === 'done' && data.queue) {
        const block = nextQueuedTask(sessionId, meta);
        if (block) return json(res, 200, { ok: true, state: shown, block });
        return json(res, 200, { ok: true, state: shown });
      }

      report(sessionId, state, meta);
      if (data.error === 'rate_limit') onLimitHit(sessionId, meta.cwd);
      json(res, 200, { ok: true, state: shown });
    });
  }

  if (req.method === 'POST' && req.url === '/permission') {
    return readBody(req, res, (data) => {
      if (config.crewOnly && !crewOf(data.crew)) return json(res, 200, {});
      askPhone(data, res);
    });
  }

  json(res, 404, { error: 'not found' });
}

// A Crew agent's run: which agent, and the `crew` command that opens it in the Crew window.
// Only a real crew.mjs and a real node binary are accepted, since a click runs them.
function crewOf(value) {
  if (!value || typeof value !== 'object') return undefined;
  const agent = text(value.agent);
  const cli = text(value.cli);
  const node = text(value.node) || 'node';
  if (!agent || !/^[a-z][a-z0-9]{1,30}$/.test(agent)) return undefined;
  if (!cli || path.basename(cli) !== 'crew.mjs' || !fs.existsSync(cli)) return undefined;
  if (!/^node(\.exe)?$/i.test(path.basename(node))) return undefined;
  // Its face (one of Crew's 25 icons) and name, shown on the widget.
  const icon = /^[a-z]{2,20}$/.test(text(value.icon) || '') ? value.icon : undefined;
  // eslint-disable-next-line no-control-regex
  const title = (text(value.title) || '').replace(/[\u0000-\u001f]/g, '').slice(0, 32) || undefined;
  return { agent, cli, node, icon, title };
}

function text(value) {
  return typeof value === 'string' && value.length < 2000 ? value : undefined;
}

// Parses a small JSON body and checks it names a session.
function readBody(req, res, onData) {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 65536) req.destroy();
  });
  req.on('end', () => {
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return json(res, 400, { error: 'invalid JSON' });
    }
    const sessionId = data && data.session_id;
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) {
      return json(res, 400, { error: 'session_id required' });
    }
    onData(data);
  });
}

function startServer() {
  const server = http.createServer(handle);
  server.on('error', (err) => {
    // the face still runs; it just can't hear the hooks
    console.error(`claude-face: could not listen on ${HOST}:${PORT} (${err.code})`);
  });
  server.listen(PORT, HOST);
}

// ---------- tray ----------

function trayIcon(state) {
  if (!trayIcons[state]) {
    trayIcons[state] = nativeImage.createFromBuffer(dotPNG(32, COLORS[state]), { scaleFactor: 2 });
  }
  return trayIcons[state];
}

// In dev the login item must point at electron.exe plus this folder.
const loginOptions = app.isPackaged ? {} : { path: process.execPath, args: [path.resolve(__dirname)] };

function startsAtLogin() {
  return app.getLoginItemSettings(loginOptions).openAtLogin;
}

function setStartAtLogin(on) {
  app.setLoginItemSettings({ openAtLogin: on, ...loginOptions });
}

// a checkbox menu item bound to an on/off setting
function toggle(label, key, after) {
  return {
    label,
    type: 'checkbox',
    checked: !!config[key],
    click: () => {
      config[key] = !config[key];
      saveConfig();
      if (after) after();
      buildTrayMenu();
    },
  };
}

function buildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: win.isVisible() ? 'Hide' : 'Show', click: toggleVisible },
    { label: 'Mini mode', type: 'checkbox', checked: config.mini, click: () => setMini(!config.mini) },
    {
      label: "Your sessions' face",
      submenu: [
        ['random', 'Each chat its own face (picked at random)'],
        ['you', 'Every chat Claude orange'],
        ['vscode', 'Every chat VS Code (black and blue)'],
      ].map(([id, label]) => ({
        label,
        type: 'radio',
        checked: config.yourFace === id,
        click: () => {
          config.yourFace = id;
          config.faceModeChosen = true;
          writeConfig();
          refresh();
          sendUpdate();
          buildTrayMenu();
        },
      })),
    },
    {
      label: 'Only Crew agents',
      type: 'checkbox',
      checked: config.crewOnly,
      click: () => {
        config.crewOnly = !config.crewOnly;
        if (config.crewOnly) for (const [id, s] of sessions) if (!s.crew) sessions.delete(id);
        writeConfig();
        refresh();
        buildTrayMenu();
      },
    },
    {
      label: 'Sound',
      type: 'checkbox',
      checked: config.sound,
      click: () => {
        config.sound = !config.sound;
        saveConfig();
        sendUpdate();
        buildTrayMenu();
      },
    },
    {
      label: 'Start at login',
      type: 'checkbox',
      checked: startsAtLogin(),
      click: () => {
        setStartAtLogin(!startsAtLogin());
        buildTrayMenu();
      },
    },
    {
      label: 'Usage meter',
      type: 'checkbox',
      checked: config.usageMeter,
      click: () => {
        config.usageMeter = !config.usageMeter;
        saveConfig();
        sendUpdate();
        updateTooltip();
        refreshUsage();
        buildTrayMenu();
      },
    },
    { type: 'separator' },
    {
      label: 'Phone ping',
      type: 'checkbox',
      checked: config.ping,
      click: () => {
        config.ping = !config.ping;
        saveConfig();
        buildTrayMenu();
      },
    },
    {
      label: 'Ping when waiting for',
      submenu: ASK_DELAYS_MIN.map((min) => ({
        label: `${min} minute${min === 1 ? '' : 's'}`,
        type: 'radio',
        checked: config.askDelayMin === min,
        click: () => {
          config.askDelayMin = min;
          saveConfig();
          scheduleAskPing();
          buildTrayMenu();
        },
      })),
    },
    { label: 'Send test ping', click: testPing },
    { label: 'Phone ping: copy topic name', click: () => clipboard.writeText(config.ntfyTopic) },
    toggle('Approve from phone when away', 'phoneApprove'),
    { type: 'separator' },
    toggle('Context warning', 'contextWarn', refresh),
    toggle(`Task queue (${QUEUE_FILE})`, 'taskQueue'),
    toggle('Auto-resume after usage limit', 'autoResume', scheduleResume),
    { type: 'separator' },
    hooks.isInstalled(HOOKS_HOME)
      ? { label: 'Disconnect from Claude Code', click: disconnectHooks }
      : { label: 'Connect to Claude Code', click: connectHooks },
    { label: 'Reset position', click: resetPosition },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
}

// ---------- connecting to Claude Code (hooks) ----------

// Node.js runs the hook when installed; otherwise the app's own executable does, in Node mode.
function hookRunner() {
  const candidates = [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe')];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    candidates.push(path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node'));
  }
  const node = candidates.find((file) => {
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  });
  return node ? { exe: node } : { exe: process.execPath, electronAsNode: true };
}

function connectHooks() {
  try {
    const result = hooks.install({ runner: hookRunner(), hookSource: path.join(__dirname, 'hook.js'), home: HOOKS_HOME });
    notify('Connected to Claude Code', 'Restart Claude Code so it picks up the hooks.' +
      (result.backupPath ? ' Your old settings were backed up next to settings.json.' : ''));
  } catch (err) {
    dialog.showErrorBox('Could not connect to Claude Code',
      `Your Claude Code settings file could not be updated, so nothing was changed.\n\n${err.message}`);
  }
  buildTrayMenu();
}

function disconnectHooks() {
  try {
    hooks.remove({ home: HOOKS_HOME });
    notify('Disconnected from Claude Code', 'The claude-face hooks were removed. Restart Claude Code.');
  } catch (err) {
    dialog.showErrorBox('Could not disconnect', err.message);
  }
  buildTrayMenu();
}

// Flags Crew's setup passes: --crew-only (show only Crew's agents), --connect (add the hooks
// without asking, since the user already said yes in Crew's setup).
function applyFlags(argv) {
  // An update may bring a newer hook: refresh the copy Claude Code runs.
  try {
    hooks.refreshHook({ hookSource: path.join(__dirname, 'hook.js'), home: HOOKS_HOME });
  } catch {
    // the copy can't be written: the old hook keeps working
  }
  let changed = false;
  if (argv.includes('--crew-only') && !config.crewOnly) {
    config.crewOnly = true;
    changed = true;
  }
  if (argv.includes('--connect') && !hooks.isInstalled(HOOKS_HOME)) {
    hooks.install({ runner: hookRunner(), hookSource: path.join(__dirname, 'hook.js'), home: HOOKS_HOME });
    config.hooksAsked = true;
    changed = true;
  }
  if (changed) {
    writeConfig();
    buildTrayMenu();
  }
}

// asked once, on the first launch, unless the hooks are already there
async function offerHooks() {
  if (config.hooksAsked || hooks.isInstalled(HOOKS_HOME)) return;
  config.hooksAsked = true;
  writeConfig();
  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Connect', 'Not now'],
    defaultId: 0,
    cancelId: 1,
    title: 'claude-face',
    message: 'Connect claude-face to Claude Code?',
    detail:
      'claude-face learns what Claude Code is doing through hooks. Connecting adds them to your ' +
      'Claude Code settings (~/.claude/settings.json). A backup is made first, and nothing already ' +
      'in the file is changed. You can disconnect any time from the tray menu.',
  });
  if (response === 0) connectHooks();
}

function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title, body }).show();
}

// works even with "Phone ping" off, so the phone setup can be checked first
function testPing() {
  sendPing(config.ntfyTopic, { title: 'claude-face test', message: 'Phone ping works.', priority: 'default' });
}

function createTray() {
  tray = new Tray(trayIcon(shown));
  tray.setToolTip('Claude Code: idle');
  tray.on('click', toggleVisible);
  buildTrayMenu();
}

// ---------- dragging and resizing (driven by the renderer) ----------

let drag = null;
let resize = null;

ipcMain.on('ready', sendUpdate);

ipcMain.on('drag-start', () => {
  const cursor = screen.getCursorScreenPoint();
  drag = { dx: cursor.x - config.x, dy: cursor.y - config.y, size: windowSize() };
});
ipcMain.on('drag-move', () => {
  if (!drag) return;
  const cursor = screen.getCursorScreenPoint();
  // always pass the size too: position-only moves let the window creep on scaled displays
  place(cursor.x - drag.dx, cursor.y - drag.dy, drag.size);
});
ipcMain.on('drag-end', () => {
  drag = null;
});

ipcMain.on('resize-start', () => {
  if (config.mini) return;
  resize = { cursor: screen.getCursorScreenPoint(), x: config.x, y: config.y, size: config.size };
});
ipcMain.on('resize-move', () => {
  if (!resize) return;
  const cursor = screen.getCursorScreenPoint();
  // Follow whichever way the pointer moved most, so dragging left or up shrinks it too.
  const dx = cursor.x - resize.cursor.x;
  const dy = cursor.y - resize.cursor.y;
  const delta = Math.abs(dx) >= Math.abs(dy) ? dx : dy;
  config.size = clamp(Math.round(resize.size + delta), MIN_SIZE, MAX_SIZE);
  place(resize.x, resize.y, config.size);
});
ipcMain.on('resize-end', () => {
  resize = null;
});

ipcMain.on('toggle-mini', () => setMini(!config.mini));
ipcMain.on('hide', () => win.hide());
ipcMain.on('focus-session', focusNeediestSession);

// ---------- app ----------

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    applyFlags(argv);
    if (win && !win.isVisible()) toggleVisible();
  });

  app.whenReady().then(() => {
    if (app.dock) app.dock.hide();
    loadConfig();

    if (!config.loginSet && app.isPackaged) {
      setStartAtLogin(true);
      config.loginSet = true;
      writeConfig();
    }

    createWindow();
    createTray();
    applyFlags(process.argv);
    startServer();
    setInterval(sweep, SWEEP_MS);
    setInterval(usageTick, USAGE_ACTIVE_MS);
    refreshUsage();
    scheduleResume(); // sessions that were waiting for a limit reset when the app last closed
    offerHooks();

    screen.on('display-removed', ensureOnScreen);
    screen.on('display-metrics-changed', ensureOnScreen);
  });

  // the widget lives in the tray; only Quit ends it
  app.on('window-all-closed', () => {});
  app.on('before-quit', writeConfig);
}
