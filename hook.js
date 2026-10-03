#!/usr/bin/env node
// Claude Code hook: reads the event JSON on stdin and tells the claude-face widget what changed.
// Must never slow down or break Claude Code: 1-second cap, always exits 0, silent if the widget
// isn't running. It prints only when the widget has an answer for Claude Code: the next queued
// task after a Stop, or an Allow / Deny given from the phone for a permission request (the one
// event that may wait longer than a second, and only while you are away from the PC).
const http = require('http');

const PERMISSION_WAIT_MS = 295000;
const DETAIL_CHARS = 80;

const quit = () => process.exit(0);
let cap = setTimeout(quit, 1000);
process.on('uncaughtException', quit);
process.on('unhandledRejection', quit);

function stateFor(event) {
  switch (event.hook_event_name) {
    case 'UserPromptSubmit':
    case 'PreToolUse':
      return 'working';
    case 'Stop':
      return 'done';
    case 'StopFailure':
      return 'idle'; // the turn died on an API error (rate limit, auth, ...)
    case 'SessionEnd':
      return 'end';
    case 'Notification': {
      // The idle reminder ("Claude is waiting for your input") is not a question.
      const idle =
        event.notification_type === 'idle_prompt' ||
        /waiting for your input/i.test(String(event.message || ''));
      return idle ? 'done' : 'asking';
    }
    default:
      return null;
  }
}

// What the phone shows for a permission request: the tool and the start of its main argument.
function describe(event) {
  const input = event.tool_input || {};
  const main = input.command || input.file_path || input.path || input.url || input.pattern || input.description || '';
  const detail = String(main).replace(/\s+/g, ' ').trim();
  return {
    tool: String(event.tool_name || 'tool').slice(0, 60),
    detail: detail.slice(0, DETAIL_CHARS),
    more: Math.max(0, detail.length - DETAIL_CHARS),
  };
}

function send(path, payload, waitMs, onReply) {
  const body = JSON.stringify(payload);
  const req = http.request(
    {
      host: '127.0.0.1',
      port: 7777,
      path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: waitMs,
    },
    (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let reply = null;
        try {
          reply = JSON.parse(text);
        } catch {
          // not an answer
        }
        onReply(reply || {});
      });
    }
  );
  req.on('error', quit);
  req.on('timeout', quit);
  req.end(body);
}

function answer(output) {
  process.stdout.write(JSON.stringify(output), quit);
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('error', quit);
process.stdin.on('end', () => {
  try {
    const event = JSON.parse(raw);
    if (!event.session_id) return quit();
    const base = { session_id: event.session_id, cwd: event.cwd, transcript: event.transcript_path };

    if (event.hook_event_name === 'PermissionRequest') {
      clearTimeout(cap);
      cap = setTimeout(quit, PERMISSION_WAIT_MS);
      return send('/permission', { ...base, ...describe(event) }, PERMISSION_WAIT_MS, (reply) => {
        if (reply.decision !== 'allow' && reply.decision !== 'deny') return quit();
        const decision =
          reply.decision === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: 'Denied from the phone.' };
        answer({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } });
      });
    }

    const state = stateFor(event);
    if (!state) return quit();
    const payload = { ...base, state };
    if (event.hook_event_name === 'Stop') payload.queue = true;
    if (event.hook_event_name === 'StopFailure') payload.error = String(event.error || 'unknown');

    send('/state', payload, 800, (reply) => {
      if (typeof reply.block === 'string' && reply.block) return answer({ decision: 'block', reason: reply.block });
      quit();
    });
  } catch {
    quit();
  }
});
