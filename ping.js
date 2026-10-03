// Phone notifications through ntfy.sh: plain HTTPS, no account, no packages.
// Pings carry a title and one short line. Permission requests also carry Allow / Deny buttons;
// a tap posts the answer to a second secret topic that this app listens to.
const https = require('https');
const crypto = require('crypto');

const RETRY_MS = 15000;
const RECONNECT_MS = 3000;

// Anyone who knows a topic can read it, so topics have to be unguessable.
function newTopic() {
  return 'claude-face-' + crypto.randomBytes(24).toString('base64url');
}

function post({ topic, title, message, priority, actions }) {
  return new Promise((resolve) => {
    const body = Buffer.from(
      JSON.stringify({ topic, title, message, priority: priority === 'high' ? 4 : 3, actions }),
      'utf8'
    );
    const req = https.request(
      {
        host: 'ntfy.sh',
        path: '/',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
        timeout: 10000,
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300));
      }
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
    req.end(body);
  });
}

// Fails silently; tries once more if the first attempt doesn't get through.
async function sendPing(topic, note) {
  if (await post({ topic, ...note })) return true;
  await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  return post({ topic, ...note });
}

// Calls onMessage(text) for every message posted to the topic from now on. Returns a stop function.
// After a dropped connection it reconnects and replays what it missed, so onMessage may see a
// message twice.
function listen(topic, onMessage) {
  const since = Math.floor(Date.now() / 1000);
  let stopped = false;
  let req = null;
  let timer = null;

  const retry = () => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(connect, RECONNECT_MS);
  };

  function connect() {
    if (stopped) return;
    req = https.get({ host: 'ntfy.sh', path: `/${encodeURIComponent(topic)}/json?since=${since}` }, (res) => {
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          try {
            const event = JSON.parse(line);
            if (event.event === 'message') onMessage(String(event.message || ''));
          } catch {
            // keep-alive or partial line
          }
        }
      });
      res.on('end', retry);
    });
    req.on('error', retry);
  }

  connect();
  return () => {
    stopped = true;
    clearTimeout(timer);
    if (req) req.destroy();
  };
}

module.exports = { newTopic, sendPing, listen };
