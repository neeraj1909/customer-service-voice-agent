// Exercise expanded fixture ownership through the actual browser and loopback API.
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.E2E_DIR;
const base = process.env.E2E_BASE;
const db = process.env.E2E_DB;
const profile = fs.mkdtempSync(path.join(root, 'orders-profile-'));
const chrome = spawn(process.env.CHROME_BIN || '/usr/bin/google-chrome', [
  '--headless=new', '--no-sandbox', '--no-first-run', '--disable-background-networking',
  '--disable-sync', '--disable-extensions', '--remote-debugging-address=127.0.0.1',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, `${base}/`,
], { stdio: 'ignore' });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function inspectDatabase() {
  const code = `import json,sqlite3,sys
with sqlite3.connect(sys.argv[1]) as c:
 print(json.dumps({'count':c.execute('select count(*) from orders').fetchone()[0], 'rows':c.execute("select id,customer,status from orders where id in ('ord-a-203','ord-b-201') order by id").fetchall(), 'operations':c.execute('select count(*) from operations').fetchone()[0], 'handoffs':c.execute('select count(*) from handoffs').fetchone()[0]}))`;
  const result = spawnSync(process.env.PYTHON_EXECUTABLE || 'python3', ['-c', code, db], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout);
}

(async () => {
  try {
    let port;
    for (let i = 0; i < 100; i++) {
      try { port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; break; }
      catch { await delay(100); }
    }
    if (!port) throw new Error('Chrome startup timed out');
    let page;
    for (let i = 0; i < 100; i++) {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      page = pages.find(item => item.type === 'page' && item.url.startsWith(base));
      if (page) break;
      await delay(100);
    }
    if (!page) throw new Error('browser page unavailable');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let id = 0;
    const pending = new Map();
    ws.onmessage = event => {
      const result = JSON.parse(event.data);
      if (result.id && pending.has(result.id)) { pending.get(result.id)(result); pending.delete(result.id); }
    };
    async function call(method, params = {}) {
      const next = ++id;
      const response = new Promise(resolve => pending.set(next, resolve));
      ws.send(JSON.stringify({ id: next, method, params }));
      const result = await response;
      if (result.error || result.result?.exceptionDetails) throw new Error(JSON.stringify(result));
      return result.result;
    }
    async function evaluate(expression) {
      return (await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;
    }
    await delay(1000);
    await call('Page.enable');
    await call('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      const original = window.fetch;
      window.__orderResponses = [];
      window.fetch = async (...args) => {
        const response = await original(...args);
        if (args[0] === '/api/order-details') {
          window.__orderResponses.push({status: response.status, body: await response.clone().json()});
        }
        return response;
      };
    })()` });
    await call('Page.reload', { ignoreCache: true });
    await delay(1200);

    const expectedRows = [['ord-a-203', 'cust-a', 'delivered'], ['ord-b-201', 'cust-b', 'processing']];
    const before = inspectDatabase();
    if (before.count !== 50 || JSON.stringify(before.rows) !== JSON.stringify(expectedRows)) {
      throw new Error(`unexpected seeded orders: ${JSON.stringify(before)}`);
    }
    async function runCustomer(customer, owned, status, foreign) {
      const result = await evaluate(`(async () => {
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
        const customer = document.getElementById('customer');
        const output = document.getElementById('result');
        customer.value = ${JSON.stringify(customer)};
        document.getElementById('start').click();
        for (let i = 0; i < 150 && !output.textContent.includes('Session started for ${customer}'); i++) await wait(30);
        if (!output.textContent.includes('Session started for ${customer}')) throw Error('session not started');
        async function lookup(order) {
          const count = window.__orderResponses.length;
          document.getElementById('order').value = order;
          document.getElementById('lookup').click();
          for (let i = 0; i < 150 && window.__orderResponses.length === count; i++) await wait(30);
          if (window.__orderResponses.length === count) throw Error('lookup timed out');
          // Allow the UI's response handler to finish after the traced network response.
          for (let i = 0; i < 150; i++) {
            if ((window.__orderResponses.at(-1).status === 200 && output.textContent.includes(order)) ||
                (window.__orderResponses.at(-1).status === 404 && output.textContent.includes('not_found'))) break;
            await wait(30);
          }
          return { wire: window.__orderResponses.at(-1), visible: output.textContent };
        }
        return [await lookup(${JSON.stringify(owned)}), await lookup(${JSON.stringify(foreign)}), await lookup('ord-absent-999')];
      })()`);
      const [own, other, absent] = result;
      if (own.wire.status !== 200 || own.wire.body.id !== owned || own.wire.body.status !== status ||
          !own.wire.body.items.length || own.wire.body.currency !== 'INR' ||
          !own.visible.includes(owned) || !own.visible.includes(status)) {
        throw new Error(`${customer} owned order mismatch: ${JSON.stringify(own)}`);
      }
      const missing = { status: 404, body: { error: 'not_found' } };
      if (JSON.stringify(other.wire) !== JSON.stringify(missing) || JSON.stringify(absent.wire) !== JSON.stringify(missing) ||
          other.visible !== absent.visible || other.visible.includes(foreign)) {
        throw new Error(`${customer} cross-customer/missing disclosure mismatch: ${JSON.stringify(result)}`);
      }
    }
    await runCustomer('cust-a', 'ord-a-203', 'delivered', 'ord-b-201');
    await runCustomer('cust-b', 'ord-b-201', 'processing', 'ord-a-203');
    const voiceTool = await evaluate(`(async () => {
      const {RealtimeVoice} = await import('/realtime-voice.mjs');
      const session = await (await fetch('/api/sessions', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({customer_id:'cust-a'})})).json();
      const sent = [];
      const request = async (path, body) => {
        const response = await fetch(path, {method:'POST', headers:{'Content-Type':'application/json', 'X-Session':session.session_id}, body:JSON.stringify(body)});
        if (!response.ok) throw Error('request failed');
        return response.json();
      };
      const voice = new RealtimeVoice({session:session.session_id, request, audio:{}});
      voice.channel = {readyState:'open', send:message => sent.push(JSON.parse(message))};
      for (const [call_id, order_id] of [['own', 'O R D dash A dash two zero one'], ['foreign', 'O R D dash B dash two zero one']]) {
        await voice.receive({type:'response.function_call_arguments.done', name:'lookup_order', call_id, arguments:JSON.stringify({order_id})});
      }
      return sent.filter(message => message.item).map(message => JSON.parse(message.item.output));
    })()`);
    if (voiceTool[0]?.id !== 'ord-a-201' || !voiceTool[0]?.items?.length || !voiceTool[1]?.error) {
      throw new Error(`voice tool scoped lookup mismatch: ${JSON.stringify(voiceTool)}`);
    }
    const after = inspectDatabase();
    if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error('order reads changed persisted state');
    console.log('ORDERS_E2E_PASS: 50 seeded records; owner and foreign lookups; spoken-form voice tool through browser and HTTP; SQLite unchanged');
    ws.close();
  } catch (error) {
    console.error('ORDERS_E2E_FAIL', error.stack);
    process.exitCode = 1;
  } finally { chrome.kill('SIGTERM'); }
})();
