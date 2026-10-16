// Unit tests for alerts.js (attention alerts, the routine check, call escalation). Invented data only, nothing leaves the machine.
// Run: docker run --rm -v "$PWD":/app -w /app node:22-alpine node --disable-warning=ExperimentalWarning scripts/test-alerts.js
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-alerts-'));
const calls = [];                                     // phone calls the fake Twilio received
let twilioFails = false;
const tw = http.createServer((req, res) => {
  const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => {
    calls.push({ url: req.url, auth: req.headers.authorization, form: new URLSearchParams(Buffer.concat(c).toString()) });
    res.writeHead(twilioFails ? 400 : 201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(twilioFails ? { message: 'Invalid To number' } : { sid: 'CA123' }));
  });
});

let failures = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + info}`); if (!ok) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hhmm = (d) => d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Colombo', hour12: false, hour: '2-digit', minute: '2-digit' });

(async () => {
  await new Promise((r) => tw.listen(0, '127.0.0.1', r));
  Object.assign(process.env, {
    DB_PATH: path.join(tmp, 'bot.db'), VAULT_DIR: path.join(tmp, 'vault'), TZ: 'Asia/Colombo', OWNER_NUMBERS: '94700000001',
    TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'secret-token', TWILIO_FROM: '+15550001111', TWILIO_API_BASE: `http://127.0.0.1:${tw.address().port}`,
    ALERT_ESCALATE_MIN: '0.01', CALL_DAILY_LIMIT: '3', CALL_MIN_GAP_MIN: '0', ALERT_MAX_PER_HOUR: '100', ALERT_QUIET: '', VIP_WAIT_MIN: '5', WATCH_INTERVAL_MIN: '0.01',
    ALERT_NUDGE_WINDOW: '00:00-23:59', CALL_SPEAK_DETAILS: '',
  });
  const db = require('../db');
  const inbox = require('../inbox');
  const alerts = require('../alerts');
  const texts = [];
  let meetings = [];
  alerts.init({ send: async (t) => { texts.push(t); }, meetings: async () => meetings, meetingsOn: () => true });
  const row = (chat, name, text, minsAgo, o = {}) => inbox.insertRaw({ msg_id: `t-${Math.random()}`, chat_id: `${chat}@c.us`, chat_name: name, sender: o.fromMe ? 'Me' : name,
    is_group: o.group, ts: Date.now() - minsAgo * 60_000, type: 'text', text, seen: true, from_me: o.fromMe, phone: o.fromMe ? '' : chat, source: o.source || 'personal' });
  const reset = () => { texts.length = 0; calls.length = 0; };
  const open = () => db.prepare('SELECT COUNT(*) n FROM alerts WHERE acked_at IS NULL AND resolved_at IS NULL').get().n;

  // --- raising, delivering, dedupe, acknowledging
  alerts.raise({ key: 'k1', kind: 'pending', text: 'Normal thing' });
  check('same key twice raises only once', alerts.raise({ key: 'k1', kind: 'pending', text: 'again' }) === false);
  await alerts.deliver();
  check('a normal alert is texted with a bell and an acknowledge hint', texts.length === 1 && texts[0].startsWith('🔔 Normal thing') && /acknowledge/.test(texts[0]), texts.join('|'));
  reset(); await alerts.deliver();
  check('an alert is not texted twice', texts.length === 0);
  check('ack() acknowledges everything open', alerts.ack() >= 1 && open() === 0);

  // --- quiet hours
  const now = new Date();
  process.env.ALERT_QUIET = `${hhmm(new Date(now.getTime() - 3_600_000))}-${hhmm(new Date(now.getTime() + 3_600_000))}`;
  reset(); alerts.raise({ key: 'q1', kind: 'pending', text: 'Normal, in quiet hours' }); alerts.raise({ key: 'q2', kind: 'message', urgent: true, text: 'Urgent, in quiet hours' });
  await alerts.deliver();
  check('quiet hours: normal alert is held, urgent one is sent', texts.length === 1 && /Urgent, in quiet hours/.test(texts[0]), texts.join('|'));
  await sleep(700); calls.length = 0; await alerts.deliver();
  check('quiet hours: no phone call is placed', calls.length === 0);
  process.env.ALERT_QUIET = ''; reset(); await alerts.deliver();
  check('after quiet hours the held alert is delivered', texts.some((t) => /Normal, in quiet hours/.test(t)), texts.join('|'));
  alerts.ack();

  // --- escalation to a phone call
  reset(); alerts.raise({ key: 'u1', kind: 'message', urgent: true, text: '*Test Alice* is waiting for you', spoken: 'You have an urgent message on WhatsApp.', detail: 'It is from Test Alice.' });
  await alerts.deliver();
  check('urgent alert: text first, no call yet', texts.length === 1 && texts[0].startsWith('🚨') && calls.length === 0);
  await sleep(900); await alerts.deliver();
  check('unacknowledged urgent alert escalates to a phone call', calls.length === 1 && /Calls\.json$/.test(calls[0].url) && calls[0].form.get('To') === '+94700000001' && calls[0].form.get('From') === '+15550001111', JSON.stringify(calls.map((c) => c.url)));
  check('call is authenticated and says nothing identifying by default', calls[0].auth === 'Basic ' + Buffer.from('ACtest:secret-token').toString('base64') && /urgent message on WhatsApp/.test(calls[0].form.get('Twiml')) && !/Alice/.test(calls[0].form.get('Twiml')), calls[0]?.form.get('Twiml'));
  check('owner is told a call was placed', texts.some((t) => /Calling you/.test(t)));
  calls.length = 0; await alerts.deliver();
  check('only one call per alert', calls.length === 0);
  alerts.ack();

  // --- an acknowledged alert never calls
  reset(); alerts.raise({ key: 'u2', kind: 'message', urgent: true, text: 'Acknowledged in time' }); await alerts.deliver(); alerts.ack(); await sleep(900); await alerts.deliver();
  check('acknowledging in time cancels the call', calls.length === 0);

  // --- failed call, call details when enabled, daily limit
  twilioFails = true; reset(); alerts.raise({ key: 'u3', kind: 'call', urgent: true, text: 'Failing call' }); await alerts.deliver(); await sleep(900); await alerts.deliver();
  check('a failed call is reported once and not retried', texts.some((t) => /tried to call you but it failed/.test(t)) && calls.length === 1, `${calls.length} calls`);
  await alerts.deliver(); check('failed call is not retried in a loop', calls.length === 1);
  twilioFails = false; alerts.ack();
  reset(); alerts.raise({ key: 'u4', kind: 'message', urgent: true, text: 'Fourth urgent' }); await alerts.deliver(); await sleep(900); await alerts.deliver(); // 3rd call of the day (limit 3)
  alerts.ack(); calls.length = 0; alerts.raise({ key: 'u5', kind: 'message', urgent: true, text: 'Fifth urgent' }); await alerts.deliver(); await sleep(900); await alerts.deliver();
  check('daily call limit is enforced', calls.length === 0, `${calls.length} calls after the limit`);
  alerts.ack();

  // --- calls off without credentials
  const sid = process.env.TWILIO_ACCOUNT_SID; delete process.env.TWILIO_ACCOUNT_SID; calls.length = 0;
  check('no Twilio credentials: calls are reported off', !alerts.callsEnabled() && /not set up/.test(await alerts.callTest()) && /text only/.test(alerts.status()));
  process.env.TWILIO_ACCOUNT_SID = sid;

  // --- flood guard
  db.exec('DELETE FROM alerts'); db.exec("DELETE FROM kv WHERE key = 'alert_flood_notice'"); process.env.ALERT_MAX_PER_HOUR = '6'; reset();
  for (let i = 0; i < 9; i++) alerts.raise({ key: `f${i}`, kind: 'pending', text: `Flood ${i}` });
  await alerts.deliver();
  check('flood guard: at most 6 texts an hour, then one notice', texts.filter((t) => /Flood/.test(t)).length === 6 && texts.filter((t) => /Several alerts are waiting/.test(t)).length === 1, texts.join('|'));
  db.exec('DELETE FROM alerts'); process.env.ALERT_MAX_PER_HOUR = '100'; reset();

  // --- scanning stored messages
  db.exec('DELETE FROM inbox_messages');
  row('94711110001', 'Test Alice', 'please call me, its urgent', 4);                                   // urgent wording, 4 min ago
  row('94711110002', 'Test Bob', 'hey are you free sometime?', 2);                                       // nothing special
  row('94711110003', 'Test Cara', 'ping', 8); row('94711110003', 'Test Cara', 'ping 2', 5); row('94711110003', 'Test Cara', 'ping 3', 3);   // burst
  row('94711110004', 'Test Dan', 'asap please', 6); row('94711110004', 'Me', 'on it', 3, { fromMe: true });                                  // answered from the phone
  row('94711110005', 'Test Eve', 'urgent!!', 5); row('94711110005', 'Me', 'auto template', 2, { fromMe: true, source: 'bot-auto' });          // only an automatic reply
  row('120363000', 'Test Group', 'urgent everyone', 5, { group: true });                                  // groups are ignored
  row('94711110006', 'Test Vic', 'hello there', 7);                                                       // a VIP, waited 7 min
  alerts.vip('add 94711110006');
  alerts.scanMessages(); await alerts.deliver();
  const said = (n) => texts.some((t) => t.includes(n));
  check('urgent wording unanswered 2+ min raises an alert', said('Test Alice') && /urgent wording/.test(texts.find((t) => t.includes('Test Alice'))));
  check('three pings in a row raise an alert', said('Test Cara'));
  check('a VIP waiting 5+ min raises an alert', said('Test Vic'));
  check('an ordinary message raises nothing', !said('Test Bob'));
  check('already answered from your phone: no alert', !said('Test Dan'));
  check('an automatic reply does not count as you answering', said('Test Eve'));
  check('group chats are ignored', !said('Test Group'));
  const before = db.prepare('SELECT COUNT(*) n FROM alerts').get().n;
  alerts.scanMessages();
  check('scanning twice does not alert twice', db.prepare('SELECT COUNT(*) n FROM alerts').get().n === before);
  alerts.ack(); reset();

  // --- VIP commands
  check('/vip lists and removes', /Test Vic/.test(alerts.vip('list')) && /Removed 1/.test(alerts.vip('remove Test Vic')) && /No VIPs/.test(alerts.vip('list')));
  row('94722220001', 'Test Sam', 'x', 100); row('94722220002', 'Test Sam', 'y', 100);
  check('/vip add by an ambiguous name asks for the number', /Several people match/.test(alerts.vip('add Test Sam')));
  check('/vip add by a unique name resolves the number', /Test Alice is a VIP/.test(alerts.vip('add Test Alice')));

  // --- meetings (calendar injected)
  const t0 = Date.now();
  meetings = [
    { id: 'm1', title: 'Project sync', startMs: t0 + 8 * 60_000, link: 'https://meet.google.com/abc-defg-hij' },
    { id: 'm2', title: 'Viva rehearsal', startMs: t0 + 90_000, link: 'https://zoom.us/j/123' },
    { id: 'm3', title: 'Far away', startMs: t0 + 25 * 60_000, link: 'https://meet.google.com/zzz' },
  ];
  await alerts.scanMeetings(true); await alerts.deliver();
  check('meeting in 8 min: heads-up with the join link', texts.some((t) => /Project sync/.test(t) && /starts in 8 min/.test(t) && /meet\.google\.com\/abc/.test(t)), texts.join('|'));
  check('meeting in 90 s: urgent alert', texts.some((t) => t.startsWith('🚨') && /Viva rehearsal/.test(t) && /starting in 2 min/.test(t)));
  check('meeting 25 min away: no alert yet', !texts.some((t) => /Far away/.test(t)));
  const n = db.prepare('SELECT COUNT(*) n FROM alerts').get().n; await alerts.scanMeetings(true);
  check('meeting alerts are not duplicated', db.prepare('SELECT COUNT(*) n FROM alerts').get().n === n);
  alerts.ack(); reset();

  // --- missed calls
  check('call.received is ignored, call.missed raises an urgent alert with the contact name', alerts.recordCall({ event: 'call.received', data: { from: '94711110001@c.us' } }) === false
    && alerts.recordCall({ event: 'call.missed', data: { callId: 'c1', from: '94711110001@c.us', chatId: '94711110001@c.us' } }) === true);
  await alerts.deliver();
  check('missed call alert names the caller', texts.some((t) => t.startsWith('🚨') && /Missed call from \*Test Alice\*/.test(t)), texts.join('|'));
  alerts.ack(); reset();

  // --- waiting-for-reply nudge (needs proof that your own replies are being recorded)
  db.exec('DELETE FROM inbox_messages'); db.exec('DELETE FROM alerts'); db.exec("DELETE FROM kv WHERE key = 'pending_nudge_at'");
  row('94733330001', 'Test Zed', 'are you there?', 180); row('94733330002', 'Test Yan', 'thanks!', 300); row('94733330002', 'Me', 'welcome', 290, { fromMe: true });
  db.exec("DELETE FROM kv WHERE key = 'watch_last_scan'");
  await alerts.tick({ suggestions: () => [{ key: 'suggest:x:1', text: '💡 Test Zed suggestion', footer: false }] });
  check('routine check sends a gentle nudge about chats waiting 2h+', texts.some((t) => /1 chat is waiting for your reply: Test Zed/.test(t)), texts.join('|'));
  check('the routine check also delivers suggestions', texts.some((t) => /Test Zed suggestion/.test(t) && !/acknowledge/.test(t)));
  reset(); await alerts.tick({ suggestions: () => [{ key: 'suggest:y:1', text: 'should not appear' }] });
  check('the full scan does not run again within the interval', !texts.some((t) => /should not appear/.test(t)));
  check('/alerts and /watch describe the state', /Open alerts|No open alerts/.test(alerts.list()) && /Checks every/.test(alerts.status()));

  tw.close(); fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED` : '\nAll alert tests passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
