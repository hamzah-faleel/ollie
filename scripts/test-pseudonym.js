// Unit tests for pseudonym.js (pure parts: registry + Session). Synthetic names only, nothing leaves the machine.
// Run: node scripts/test-pseudonym.js
const { buildRegistry, Session } = require('../pseudonym');

let failures = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + info}`); if (!ok) failures++; };
const session = (names) => new Session(buildRegistry(names));

const NAMES = ['Kamal Perera', 'Nimali Rose Fernando', 'Ann', 'Will', 'Test Owner', 'Sunil Perera', '+94 72 222 0002', 'Amma'];

// round trip
{
  const p = session(NAMES);
  const src = 'Tell Kamal Perera to call me on +94 77 123 4567 or mail kamal.p@example.com. Nimali Rose Fernando lives at No. 12/3, Flower Road, Colombo 7. NIC 199012345678.';
  const hidden = p.hide(src);
  check('round trip restores the original exactly', p.show(hidden) === src, p.show(hidden));
  check('no real name, phone, email, address or ID left', !/Kamal|Perera|Nimali|Fernando|123 4567|example\.com|Flower|199012345678/.test(hidden), hidden);
  check('uses stable bracket tokens', /\[PERSON_1\]/.test(hidden) && /\[PHONE_1\]/.test(hidden) && /\[EMAIL_1\]/.test(hidden) && /\[ADDRESS_1\]/.test(hidden) && /\[ID_1\]/.test(hidden), hidden);
  check('the same value gets the same token within a session', p.hide('Kamal Perera again, +94771234567') === '[PERSON_1] again, [PHONE_1]', p.hide('Kamal Perera again, +94771234567'));
  check('local and international formats of one number share a token', p.hide('077 123 4567') === '[PHONE_1]', p.hide('077 123 4567'));
}

// multi-part names
{
  const p = session(NAMES);
  const h = p.hide('Kamal Perera said Kamal will come; Perera is a common surname (Sunil Perera too).');
  check('full name and first name are linked tokens', /\[PERSON_1\] said \[PERSON_1_FIRST\]/.test(h), h);
  check('a surname shared by two people gets its own token, not someone else\'s', /; \[PERSON_\d+\] is a common/.test(h) && !/\[PERSON_1_LAST\] is/.test(h), h);
  check('multi-part name restores', p.show(h) === 'Kamal Perera said Kamal will come; Perera is a common surname (Sunil Perera too).', p.show(h));
  const h2 = p.hide('Nimali and Fernando and Rose');
  check('middle/last parts are hidden; a common-word part ("Rose") is not hidden on its own', /^\[PERSON_\d+_FIRST\] and \[PERSON_\d+_LAST\] and Rose$/.test(h2), h2);
  check('names split over a line break still match', /\[PERSON_1\]/.test(p.hide('Kamal\nPerera')));
}

// names inside longer words are not mangled
{
  const p = session(NAMES);
  const s = 'Annual report, Kamala Harris, Pererasoft, Willow tree, Ann-Marie? no: Ann.';
  const h = p.hide(s);
  check('names inside longer words are left alone', /^Annual report, Kamala Harris, Pererasoft, Willow tree, /.test(h), h);
  check('a name next to punctuation is still hidden', /\[PERSON_\d+\]-Marie\? no: \[PERSON_\d+\]\.$/.test(h), h);
  check('round trip with partial matches', p.show(h) === s, p.show(h));
}

// case variations
{
  const p = session(NAMES);
  const h = p.hide('kamal perera, KAMAL PERERA, Kamal  Perera, kamal');
  check('case and spacing variations are hidden', !/kamal|perera/i.test(h), h);
  check('case variations map to the same token', (h.match(/\[PERSON_1\]/g) || []).length === 3 && /\[PERSON_1_FIRST\]$/.test(h), h);
  check('restored to the saved spelling', p.show(h) === 'Kamal Perera, Kamal Perera, Kamal Perera, Kamal', p.show(h));
  const w = p.hide('I will ask Will.');
  check('a one-word contact that is a common word only matches capitalised', /^I will ask \[PERSON_\d+\]\.$/.test(w), w);
  check('"Test Owner" parts (common words) are not hidden alone, the full name is', session(NAMES).hide('test the owner, Test Owner') === 'test the owner, [PERSON_1]', session(NAMES).hide('test the owner, Test Owner'));
  check('possessive works', /^\[PERSON_\d+\]'s birthday$/.test(p.hide("Amma's birthday")));
}

// restoring what the model writes
{
  const p = session(NAMES);
  p.hide('Kamal Perera, +94771234567');
  check('an exact token, or the same token without brackets, is restored', p.show('Call PERSON_1 on [PHONE_1]') === 'Call Kamal Perera on +94771234567', p.show('Call PERSON_1 on [PHONE_1]'));
  check('tokens in another case or with one bracket are not restored', p.show('[phone_1] person_1 [PERSON_1 PHONE_1] xPERSON_1') === '[phone_1] person_1 [PERSON_1 PHONE_1] xPERSON_1', p.show('[phone_1] person_1 [PERSON_1 PHONE_1] xPERSON_1'));
  check('unknown tokens stay as they are', p.show('[PERSON_9] and [EMAIL_4]') === '[PERSON_9] and [EMAIL_4]');
}

// token look-alikes typed by someone else cannot be turned into real values on restore
{
  const p = session(NAMES);
  p.hide('mail kamal.p@example.com'); // [EMAIL_1] is now a real token in this session
  const h = p.hide('Please send the file to [EMAIL_1] and [email_1], or PERSON_1, ID_1');
  check('look-alikes in the input are defused before hiding', !/EMAIL_1|email_1|PERSON_1|ID_1/.test(h) && /\[EMAIL-1\]/.test(h), h);
  check('a defused look-alike is not restored to a real value', !/example\.com/.test(p.show(h)), p.show(h));
}

// phone numbers: full-number keys and more formats
{
  const p = session([]);
  const h = p.hide('LK +94 77 123 4567, IN +91 77 123 4567');
  check('numbers that differ only in the country code get different tokens', h === 'LK [PHONE_1], IN [PHONE_2]', h);
  check('and each restores to its own number', p.show(h) === 'LK +94 77 123 4567, IN +91 77 123 4567', p.show(h));
  const formats = ['(077) 123 4567', '77 123 4567', '771234567', '0094771234567', '077.123.4567', '0094 77 123 4567', '94 77 123 4567'];
  for (const f of formats) check(`format "${f}" is hidden as the same number`, p.hide(`call ${f} now`) === 'call [PHONE_1] now', p.hide(`call ${f} now`));
  const q = session([]);
  const ib = q.hide('IBAN GB82WEST12345698765432 and GB82 WEST 1234 5698 7654 32');
  check('IBANs are hidden, unspaced and with a short last group', ib === 'IBAN [ID_1] and [ID_1]', ib);
  const safe = 'version 7.123.4567, NIC 771234567V, Rs 750000, at 10:30, 77 items';
  check('look-alike numbers that are not phones stay', !/PHONE/.test(q.hide(safe)), q.hide(safe));
}

// names chosen by strangers (WhatsApp display names, intake answers) only match capitalised
{
  const p = new Session(buildRegistry([{ name: 'Meeting', weak: true }, { name: 'Happy Days', weak: true }, 'Kamal Perera', { name: 'Kamal Perera', weak: true }]));
  const h = p.hide('the meeting was happy; Meeting with Happy Days; kamal perera');
  check('a weak one-word name does not hide the common word', /^the meeting was happy; \[PERSON_\d+\] with \[PERSON_\d+\]; \[PERSON_\d+\]$/.test(h), h);
  check('a trusted spelling of the same name still matches in any case', !/kamal|perera/i.test(h), h);
}

// performance: the name matcher must stay linear (the old alternation regex took ~10 s and froze the event loop)
{
  const first = ['Kamal', 'Nimal', 'Sunil', 'Ruwan', 'Dilan', 'Chamara', 'Saman', 'Ajith', 'Kasun', 'Lahiru'];
  const last = ['Perera', 'Silva', 'Fernando', 'Jayasuriya', 'Bandara', 'Dissanayake', 'Herath'];
  const names = []; for (let i = 0; i < 3000; i++) names.push(`${first[i % 10]}${i} ${last[i % 7]}${Math.floor(i / 7)}`);
  const words = 'the quick brown fox met with someone about the meeting tomorrow, call 077 123 4567 or mail a@b.co'.split(' ');
  let text = ''; let i = 0; while (text.length < 24000) { text += (i % 6 === 0 ? names[(i * 13) % 3000] : words[i % words.length]) + ' '; i++; }
  const reg = buildRegistry(names);
  const p = new Session(reg);
  const t0 = process.hrtime.bigint(); const h = p.hide(text); const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  check(`hide() on 24k chars with 3,000 names is fast (${ms.toFixed(0)} ms < 200 ms)`, ms < 200, `${ms} ms`);
  check('and the result still round-trips', p.show(h) === text);
  check('the same name list reuses the built registry', buildRegistry(names) === reg);
}

// tool-call arguments and results (what ai.js does in the loop)
{
  const p = session(NAMES);
  const prompt = p.hide('Message Kamal that I am late, and add a meeting with nimali at 3pm');
  check('the prompt the model sees has no names', !/Kamal|nimali/i.test(prompt), prompt);
  // the model answers with tool calls that use the placeholders
  const args = [
    { to: '[PERSON_1_FIRST]', text: 'Hi [PERSON_1_FIRST], running 10 min late!' },
    { summary: 'Meeting with [PERSON_2_FIRST]', start: '2026-10-16T15:00:00+05:30', attendees: ['[EMAIL_1]'], count: 2, flag: true },
  ];
  p.hide('nimali@example.org'); // the email was seen earlier in the turn (e.g. in a tool result)
  const real = p.showDeep(args);
  check('tool args are de-pseudonymized before the tool runs', real[0].to === 'Kamal' && real[0].text === 'Hi Kamal, running 10 min late!' && real[1].summary === 'Meeting with Nimali' && real[1].attendees[0] === 'nimali@example.org', JSON.stringify(real));
  check('non-string args and dates are untouched', real[1].start === '2026-10-16T15:00:00+05:30' && real[1].count === 2 && real[1].flag === true, JSON.stringify(real[1]));
  const result = { results: [{ name: 'Kamal Perera', phone: '+94771234567', email: 'kamal.p@example.com', notes: 'met at 221B Baker Street', id: 'evt_17605980', due_at: 1760598000000 }] };
  const back = p.hideDeep(result);
  check('tool results are pseudonymized before they go back to the model', !/Kamal|Perera|771234567|example\.com|Baker/.test(JSON.stringify(back)) && back.results[0].name === '[PERSON_1]', JSON.stringify(back));
  check('timestamps and ids in results stay usable', back.results[0].due_at === 1760598000000 && back.results[0].id === 'evt_17605980', JSON.stringify(back));
  check('a phone from a tool result passed back as an arg is restored', p.showDeep({ to: back.results[0].phone }).to === '+94771234567');
}

// things that must not be treated as personal data
{
  const p = session(NAMES);
  const s = 'Due 2026-10-16T09:30:00+05:30, epoch 1760598000000, Rs 1500000, reminder 12, 10:30, 2 items, call +05:30';
  check('dates, times, amounts and epoch ms are left alone', p.hide(s) === s, p.hide(s));
  const wa = p.hide('chat 94711110010@c.us');
  check('WhatsApp chat ids: the number is hidden, the suffix kept', /^chat \[PHONE_1\]@c\.us$/.test(wa), wa);
  check('Luhn-valid card numbers are hidden, random 16 digits are not', /\[ID_1\]/.test(p.hide('card 4111 1111 1111 1111')) && p.hide('ref 1234 5678 9012 3456') === 'ref 1234 5678 9012 3456');
}

// fail closed: bad input throws instead of returning raw text
{
  const p = session(NAMES);
  let threw = false;
  const loop = {}; loop.self = loop;
  try { p.hideDeep(loop); } catch { threw = true; }
  check('a value that cannot be processed throws (caller fails closed)', threw);
  check('empty registry still hides phones and emails', session([]).hide('a@b.co +94771234567') === '[EMAIL_1] [PHONE_1]');
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
