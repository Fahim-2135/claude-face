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
    if (!first && soundOn) chime(state);
  }
  showFaces(data.faces || [], data.state);
});

// ---------- the faces: five heads, the most urgent in front ----------

const CF = window.CrewFaces;
document.getElementById('defs').innerHTML = CF.DEFS;

// Your own Claude Code sessions: Claude's orange, or VS Code's black and blue.
const OWN = {
  you: { shape: 'squircle', color: '#D97757' },
  vscode: { shape: 'squircle', color: '#1F2633', code: true },
};
const DARK = '#2a211c';

/** One head: a Crew Critter's body, face and prop, without arms or feet. */
function head(icon, mood) {
  const own = OWN[icon];
  const c = own || CF.CRITTERS[icon] || CF.CRITTERS.crown;
  const sh = CF.SHAPES[c.shape];
  const tint = own && own.code ? c.color : CF.mix(c.color, '#ffffff', 0.3);
  // At work the heads look focused (a flat mouth); dozing has no floating z's here.
  let f = CF.face(mood === 'working' ? 'smile' : mood, sh.eyeY, false).replace(/<g class="zz"[\s\S]*?<\/g>/, '');
  if (mood === 'working') f = f.replace(`d="M46 ${sh.eyeY + 9}q4 3.5 8 0"`, `d="M46.5 ${sh.eyeY + 10}h7"`);
  let top = '';
  if (own && own.code) {
    // Light eyes on a dark face, blue blush, a blue rim and a </> on top.
    f = f.split(DARK).join('#E8F1FF').split('#ff7088').join('#3794FF');
    top = `<path d="M37 ${sh.top - 12}l-6 5 6 5M63 ${sh.top - 12}l6 5-6 5M53.5 ${sh.top - 16}l-7 15" fill="none" stroke="#3794FF" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>`;
  } else if (!own) {
    const p = CF.prop(icon in CF.CRITTERS ? icon : 'crown', sh.top, sh.eyeY, c.color);
    return `${p.back || ''}${body(sh, c, tint)}${f}${p.front}`;
  }
  const rim = own && own.code ? sh.body('fill="none" stroke="#3794FF" stroke-width="2.4"') : '';
  return `${body(sh, c, tint)}${rim}${f}${top}`;
}

function body(sh, c, tint) {
  return sh.body(CF.paint(c.shape, tint)) + sh.body('fill="url(#crew-shade)"') + sh.body('fill="url(#crew-shine)"');
}

// Front seat, then the four corners: [centre x, centre y, size] in % of the widget.
const SEATS = [[50, 43, 58], [17, 17, 24], [83, 17, 24], [17, 66, 24], [83, 66, 24]];
const crewEl = document.getElementById('crew');
const dotFace = document.getElementById('dot-face');
const drawn = new Map(); // key -> element
let dotKey = '';

/** A Crew agent seen without its face (an older Crew) wears the one Crew would give it. */
function iconOf(face) {
  if (face.icon) return face.icon;
  return face.kind === 'crew' ? CF.iconFor(face.key.slice('crew:'.length)) : 'crown';
}

function svgFor(face) {
  return `<svg viewBox="0 6 100 86"><g class="hd">${head(iconOf(face), face.state)}</g></svg>`;
}

function showFaces(faces, fallback) {
  const lead = faces[0];
  document.body.dataset.state = lead ? lead.state : fallback;
  const keep = new Set(faces.map((f) => f.key));
  for (const [key, el] of drawn) {
    if (!keep.has(key)) {
      el.remove();
      drawn.delete(key);
    }
  }
  faces.forEach((face, i) => {
    let el = drawn.get(face.key);
    if (!el) {
      // A new head appears in its seat; only a change of seat glides.
      el = document.createElement('div');
      el.style.transition = 'none';
      crewEl.append(el);
      drawn.set(face.key, el);
      requestAnimationFrame(() => requestAnimationFrame(() => (el.style.transition = '')));
    }
    const [x, y, s] = SEATS[i];
    el.className = `seat n${i}${i === 0 ? ' lead' : ''}`;
    el.style.left = `${x - s / 2}%`;
    el.style.top = `${y - s / 2}%`;
    el.style.width = `${s}%`;
    el.style.height = `${s}%`;
    el.style.zIndex = i === 0 ? '2' : '1';
    const look = `${face.icon}:${face.state}`;
    if (el.dataset.look !== look) {
      el.dataset.look = look;
      el.dataset.s = face.state;
      el.innerHTML = svgFor(face);
      if (face.title) {
        const name = document.createElement('span');
        name.className = 'who';
        // An agent known only by its id ("social") reads as a name ("Social").
        name.textContent = /^[a-z]/.test(face.title) ? face.title[0].toUpperCase() + face.title.slice(1) : face.title;
        el.append(name);
      }
    }
  });
  // Mini mode: just the front face, in a small round badge.
  const dotLook = lead ? `${lead.icon}:${lead.state}` : '';
  if (lead && dotLook !== dotKey) {
    dotKey = dotLook;
    dotFace.dataset.s = lead.state;
    dotFace.innerHTML = svgFor(lead);
  }
}

// ---------- usage meter ----------

const usageEl = document.getElementById('usage');
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
  // A native tooltip: it can open outside the widget, so the numbers are never cut off.
  usageEl.title = lines.join('\n');
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
