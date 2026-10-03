// Weather from Open-Meteo (free, no API key). Location is geocoded once from WEATHER_LOCATION.
const TZ = process.env.TZ || 'Asia/Colombo';
const LOCATION = process.env.WEATHER_LOCATION || 'Colombo';

const WMO = {
  0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'foggy', 48: 'foggy',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain',
  80: 'rain showers', 81: 'rain showers', 82: 'violent showers', 95: 'thunderstorms', 96: 'thunderstorms with hail', 99: 'thunderstorms with hail',
};
const describe = (code) => WMO[code] || 'unsettled';

let place = null;
async function locate() {
  if (place) return place;
  const lat = Number(process.env.WEATHER_LAT), lon = Number(process.env.WEATHER_LON);
  if (process.env.WEATHER_LAT && process.env.WEATHER_LON && !Number.isNaN(lat) && !Number.isNaN(lon)) {
    return (place = { name: LOCATION, lat, lon });
  }
  const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(LOCATION)}`);
  const hit = (await res.json()).results?.[0];
  if (!hit) throw new Error(`Could not find a place called "${LOCATION}" (set WEATHER_LOCATION)`);
  return (place = { name: hit.name, lat: hit.latitude, lon: hit.longitude });
}

// Today plus the next few days, compact.
async function forecast({ days = 3 } = {}) {
  const p = await locate();
  const n = Math.min(Math.max(Number(days) || 3, 1), 7);
  const url = 'https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({
    latitude: p.lat, longitude: p.lon, timezone: TZ, forecast_days: n,
    current: 'temperature_2m,weather_code',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
  });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const j = await res.json();
  return {
    place: p.name,
    now: { temp_c: Math.round(j.current.temperature_2m), conditions: describe(j.current.weather_code) },
    days: j.daily.time.map((date, i) => ({
      date, conditions: describe(j.daily.weather_code[i]),
      high_c: Math.round(j.daily.temperature_2m_max[i]), low_c: Math.round(j.daily.temperature_2m_min[i]),
      rain_chance_pct: j.daily.precipitation_probability_max[i],
    })),
  };
}

// One line for the morning briefing.
async function briefingLine() {
  const f = await forecast({ days: 1 });
  const d = f.days[0];
  const umbrella = d.rain_chance_pct >= 50 ? ' - take an umbrella ☔' : '';
  return `${f.place}: ${d.conditions}, ${d.low_c}-${d.high_c}°C, ${d.rain_chance_pct}% chance of rain${umbrella}`;
}

module.exports = { forecast, briefingLine };
