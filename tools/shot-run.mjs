// Driving-frame capture for the pre-generation check: same browser, same page, one
// real WebGL frame after N seconds of the harness pilot driving.
//   node tools/shot-run.mjs <seconds> <port> <out.png> <url>
const [secsArg, portArg, out, url] = [
  Number(process.argv[2] || 34), process.argv[3] || '9223',
  process.argv[4] || 'shots/pregen-driving.png',
  process.argv[5] || 'http://127.0.0.1:8123/index.html?perftest=1&menu=off',
];
const ver = await (await fetch(`http://127.0.0.1:${portArg}/json/version`)).json();
let id = 0; const pend = new Map();
const wire = (s) => s.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); }
});
const call = (s, method, params = {}) => new Promise((res) => {
  const mid = ++id; pend.set(mid, res); s.send(JSON.stringify({ id: mid, method, params }));
});
const bws = new WebSocket(ver.webSocketDebuggerUrl); wire(bws);
await new Promise((res, rej) => { bws.addEventListener('open', res); bws.addEventListener('error', rej); });
const { targetId } = await call(bws, 'Target.createTarget', { url, newWindow: true });
await new Promise((r) => setTimeout(r, 800));
const list = await (await fetch(`http://127.0.0.1:${portArg}/json/list`)).json();
const page = list.find((t) => t.targetId === targetId) || list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl); wire(ws);
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
await call(ws, 'Runtime.enable'); await call(ws, 'Page.enable');
await new Promise((r) => setTimeout(r, secsArg * 1000));
const shot = await call(ws, 'Page.captureScreenshot', { format: 'png' });
const fs = await import('node:fs');
fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
const diag = await call(ws, 'Runtime.evaluate', {
  expression: "(document.getElementById('perflog')||{}).textContent || ''", returnByValue: true,
});
console.log(out, (fs.statSync(out).size / 1024).toFixed(0) + ' kB');
console.log(((diag.result && diag.result.value) || '').split('\n').slice(-4).join('\n'));
ws.close(); process.exit(0);
