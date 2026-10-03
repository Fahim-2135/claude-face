const api = window.claudeFace;
const widget = document.getElementById('widget');
const resizeHandle = document.getElementById('resize');
const dot = document.getElementById('dot');

let state = null;
let soundOn = true;

// ---------- state from the main process ----------

api.onUpdate((data) => {
  soundOn = data.sound;
  showUsage(data.usage);
  showContext(data.context);
  document.body.classList.toggle('mini', data.mini);
  if (data.state !== state) {
    const first = state === null;
    state = data.state;
    document.body.dataset.state = state;
    if (!first && soundOn) chime(state);
  }
});

// ---------- usage meter ----------

const usageEl = document.getElementById('usage');
const usageLabel = document.getElementById('usage-label');
let usage = null; // { percent, resetsAt } or null when it can't be read

function usageColor(percent) {
  if (percent > 85) return '#ff5c5c';
  if (percent >= 60) return '#ffb020';
  return '#4cd787';
}

function untilReset(resetsAt) {
  if (!resetsAt) return 'not started';
  const mins = Math.max(0, Math.round((resetsAt - Date.now()) / 60000));
  if (mins >= 1440) return `↻ ${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h`;
  return '↻ ' + (mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`);
}

// e.g. "5h 72% used ↻ 2h 14m" (↻ = time until the limit resets)
function describeWindow(name, window) {
  return `${name} ${Math.round(window.percent)}% used ${untilReset(window.resetsAt)}`;
}

// the time left changes every minute, so the text is written when the pointer arrives
function describeUsage() {
  if (!usage) {
    dot.title = 'Show face';
    return;
  }
  const lines = [describeWindow('5h', usage)];
  if (usage.week) lines.push(describeWindow('week', usage.week));
  usageLabel.textContent = lines.join('\n');
  dot.title = 'Show face · used: ' + lines.join(', ');
}

function showUsage(next) {
  usage = next || null;
  const style = document.documentElement.style;
  document.body.classList.toggle('has-usage', !!usage);
  document.body.classList.toggle('has-week', !!usage && !!usage.week);
  if (usage) {
    style.setProperty('--pct', usage.percent);
    style.setProperty('--usage', usageColor(usage.percent));
  }
  if (usage && usage.week) {
    style.setProperty('--week-pct', usage.week.percent);
    style.setProperty('--week', usageColor(usage.week.percent));
  }
  describeUsage();
}

usageEl.addEventListener('pointerenter', describeUsage);
dot.addEventListener('pointerenter', describeUsage);

// ---------- context warning ----------

const contextEl = document.getElementById('context');

// percent of the fullest session's context, or null while nothing is near full
function showContext(percent) {
  contextEl.hidden = !percent;
  if (!percent) return;
  contextEl.textContent = `ctx ${percent}%`;
  contextEl.classList.toggle('critical', percent >= 90);
}

// ---------- sound (Web Audio, no files) ----------

const CHIMES = {
  done: { type: 'sine', notes: [[523.25, 0], [659.25, 0.11], [783.99, 0.22]], length: 0.7 },
  asking: { type: 'triangle', notes: [[880, 0], [1174.66, 0.16]], length: 0.45 },
};

let audio = null;

function chime(name) {
  const spec = CHIMES[name];
  if (!spec) return;
  audio = audio || new AudioContext();
  audio.resume();
  for (const [freq, delay] of spec.notes) {
    const start = audio.currentTime + delay;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = spec.type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.11, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + spec.length);
    osc.connect(gain).connect(audio.destination);
    osc.start(start);
    osc.stop(start + spec.length + 0.05);
  }
}

// ---------- dragging and resizing ----------
// Done by hand instead of with -webkit-app-region, which would swallow hover and clicks.

function track(el, prefix, onClick) {
  let active = false;
  let moved = false;
  let queued = false;
  let startX = 0;
  let startY = 0;

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    if (el === widget && e.target === resizeHandle) return;
    active = true;
    moved = false;
    startX = e.screenX;
    startY = e.screenY;
    el.setPointerCapture(e.pointerId);
    api.send(prefix + '-start');
  });

  el.addEventListener('pointermove', (e) => {
    if (!active) return;
    if (!moved && Math.abs(e.screenX - startX) + Math.abs(e.screenY - startY) < 4) return;
    moved = true;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if (active) api.send(prefix + '-move');
    });
  });

  const finish = () => {
    if (!active) return;
    active = false;
    api.send(prefix + '-end');
    if (!moved && onClick) onClick();
  };
  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', finish);
}

track(widget, 'drag', () => api.send('focus-session')); // a plain click jumps to the session that needs you
track(resizeHandle, 'resize');
track(dot, 'drag', () => api.send('toggle-mini'));

document.getElementById('btn-mini').addEventListener('click', () => api.send('toggle-mini'));
document.getElementById('btn-hide').addEventListener('click', () => api.send('hide'));

api.send('ready');
