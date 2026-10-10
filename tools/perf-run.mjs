// Headless perf capture (perftest only). Launch Chrome with --remote-debugging-port
// and read the #perflog mirror node over CDP once the harness has reached its
// PERF_SUMMARY line. --dump-dom / --virtual-time-budget never let rAF tick, so the
// only reproducible capture is a real-time run driven over the DevTools socket.
//
//   node tools/perf-run.mjs [seconds] [port] [url]
const secs = Number(process.argv[2] || 80);   // the harness only emits PERF_SUMMARY at t=70 s
const port = process.argv[3] || '9223';
const url = process.argv[4] ||
  'http://127.0.0.1:8123/index.html?perftest=1&menu=off';

// The run owns its own tab: an occluded/background page target never ticks rAF, which
// is how this tool used to end up printing nothing at all.
const pageLog = [];
const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
let id = 0;
const pend = new Map();
const wire = (sock) => sock.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); }
});
const call = (sock, method, params = {}) => new Promise((res) => {
  const mid = ++id; pend.set(mid, res); sock.send(JSON.stringify({ id: mid, method, params }));
});
const bws = new WebSocket(ver.webSocketDebuggerUrl);
wire(bws);
await new Promise((res, rej) => { bws.addEventListener('open', res); bws.addEventListener('error', rej); });
const { targetId } = await call(bws, 'Target.createTarget', { url, newWindow: true });
await new Promise((r) => setTimeout(r, 800));
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.targetId === targetId) || list.find((t) => t.type === 'page');
if (!page) { console.error('no page target on port ' + port); process.exit(2); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
wire(ws);
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
const send = (method, params = {}) => call(ws, method, params);
await send('Runtime.enable');
await send('Page.enable');
// Without this the tool can only ever report "NO PERFLOG OUTPUT" when the page dies
// before the harness emits anything: surface why instead of the silence.
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    pageLog.push('EXC ' + ((d.exception && d.exception.description) || d.text || '').split('\n')[0]);
  } else if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
    pageLog.push(m.params.type.toUpperCase() + ' ' + (m.params.args || []).map((x) => x.value ?? x.description ?? '').join(' ').slice(0, 220));
  }
});

const deadline = Date.now() + secs * 1000;
let text = '';
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 4000));
  const r = await send('Runtime.evaluate', {
    expression: "document.getElementById('perflog') ? document.getElementById('perflog').textContent : ''",
    returnByValue: true,
  });
  text = (r && r.result && r.result.value) || text;
  if (text.includes('PERF_SUMMARY')) break;
}
const ok = text.includes('PERF_SUMMARY');
console.log((ok ? text : text + '\n' + pageLog.join('\n')).trim() || 'NO PERFLOG OUTPUT');
ws.close();
process.exit(ok ? 0 : 1);
