// Google Calendar: list / create / update / delete events. Results are trimmed to keep Gemini tokens low.
const google = require('./google');

const TZ = process.env.TZ || 'Asia/Colombo';
const CALENDARS = (process.env.GOOGLE_CALENDAR_IDS || 'primary').split(',').map((s) => s.trim()).filter(Boolean);
const BASE = 'https://www.googleapis.com/calendar/v3/calendars';
const evUrl = (cal, id = '') => `${BASE}/${encodeURIComponent(cal)}/events${id ? '/' + encodeURIComponent(id) : ''}`;

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const addDays = (date, n) => { const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
function parseTime(s, field) {
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new Error(`Invalid ${field}: "${s}". Use ISO 8601 with offset, e.g. 2026-10-02T13:00:00+05:30`);
  return ms;
}
// Calendar API time object. Date-only strings become all-day.
const when = (s, field) => (isDate(s) ? { date: s } : { dateTime: new Date(parseTime(s, field)).toISOString(), timeZone: TZ });

function startOfDay(offsetDays = 0) {
  const d = new Date(); // container TZ is the owner's TZ
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return d;
}

function compact(e, cal) {
  const allDay = Boolean(e.start?.date);
  return {
    id: e.id,
    ...(CALENDARS.length > 1 ? { calendar: cal } : {}),
    title: e.summary || '(no title)',
    start: e.start?.dateTime || e.start?.date,
    // all-day end dates from Google are exclusive; show the last day instead
    end: allDay ? addDays(e.end.date, -1) : e.end?.dateTime,
    ...(allDay ? { all_day: true } : {}),
    ...(e.location ? { location: e.location } : {}),
    ...(e.description ? { description: e.description.slice(0, 200) } : {}),
  };
}

async function listEvents({ from, to, query } = {}) {
  const min = from ? new Date(parseTime(from, 'from')) : startOfDay();
  const max = to ? new Date(parseTime(to, 'to')) : new Date(min.getTime() + 86_400_000);
  const params = new URLSearchParams({
    timeMin: min.toISOString(), timeMax: max.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '50', timeZone: TZ,
    ...(query ? { q: query } : {}),
  });
  const lists = await Promise.all(CALENDARS.map(async (cal) =>
    ((await google.api(`${evUrl(cal)}?${params}`)).items || []).filter((e) => e.status !== 'cancelled').map((e) => compact(e, cal))));
  const events = lists.flat().sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return { from: min.toISOString(), to: max.toISOString(), events };
}

async function createEvent({ title, start, end, location, description }) {
  if (!title || !start) return { error: 'Need title and start.' };
  const body = { summary: title, ...(location ? { location } : {}), ...(description ? { description } : {}) };
  if (isDate(start)) {
    body.start = { date: start };
    body.end = { date: addDays(end && isDate(end) ? end : start, 1) }; // end is inclusive for the owner, exclusive for Google
  } else {
    body.start = when(start, 'start');
    body.end = end ? when(end, 'end') : { dateTime: new Date(parseTime(start, 'start') + 3_600_000).toISOString(), timeZone: TZ };
  }
  const e = await google.api(evUrl(CALENDARS[0]), { method: 'POST', body });
  return { ok: true, created: compact(e, CALENDARS[0]) };
}

async function updateEvent({ id, calendar = CALENDARS[0], title, start, end, location, description }) {
  const old = await google.api(evUrl(calendar, id));
  const body = {};
  if (title) body.summary = title;
  if (location != null) body.location = location;
  if (description != null) body.description = description;
  if (start) {
    if (isDate(start)) {
      body.start = { date: start };
      body.end = { date: addDays(end && isDate(end) ? end : start, 1) };
    } else {
      body.start = when(start, 'start');
      // keep the original duration when only the start moves
      const dur = old.start?.dateTime ? Date.parse(old.end.dateTime) - Date.parse(old.start.dateTime) : 3_600_000;
      body.end = end ? when(end, 'end') : { dateTime: new Date(parseTime(start, 'start') + dur).toISOString(), timeZone: TZ };
    }
  } else if (end) {
    body.end = isDate(end) ? { date: addDays(end, 1) } : when(end, 'end');
  }
  const e = await google.api(evUrl(calendar, id), { method: 'PATCH', body });
  return { ok: true, updated: compact(e, calendar) };
}

async function deleteEvent({ id, calendar = CALENDARS[0] }) {
  const e = await google.api(evUrl(calendar, id));
  await google.api(evUrl(calendar, id), { method: 'DELETE' });
  return { ok: true, deleted: e.summary || '(no title)' };
}

module.exports = { enabled: google.enabled, listEvents, createEvent, updateEvent, deleteEvent, startOfDay };
