// Headless perf capture (perftest only). Launch Chrome with --remote-debugging-port
// and read the #perflog mirror node over CDP once the harness has reached its
// PERF_SUMMARY line. --dump-dom / --virtual-time-budget never let rAF tick, so the
// only reproducible capture is a real-time run driven over the DevTools socket.
//
//   node tools/perf-run.mjs [seconds] [port] [url]
const secs = Number(process.argv[2] || 74);
const port = process.argv[3] || '9223';
const url = process.argv[4] ||
  'http://localhost:8123/index.html?perftest=1&menu=off';

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
if (!page) { console.error('no page target on port ' + port); process.exit(2); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const send = (method, params = {}) => new Promise((res) => {
  const mid = ++id;
  const on = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id === mid) { ws.removeEventListener('message', on); res(m.result); }
  };
  ws.addEventListener('message', on);
  ws.send(JSON.stringify({ id: mid, method, params }));
});

await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url });

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
console.log(text.trim() || 'NO PERFLOG OUTPUT');
ws.close();
process.exit(text.includes('PERF_SUMMARY') ? 0 : 1);
