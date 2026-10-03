// Voice replies: Gemini TTS (raw PCM) -> ffmpeg -> OGG/Opus, the format WhatsApp plays as a voice note.
const { spawn } = require('child_process');

const KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.TTS_MODEL || 'gemini-2.5-flash-preview-tts';
const VOICE = process.env.TTS_VOICE || 'Kore';
const MAX_CHARS = Number(process.env.TTS_MAX_CHARS || 700); // longer answers are text-only (keeps free-tier quota and notes short)

// Strip WhatsApp formatting and links so the voice does not read out asterisks and URLs.
const speakable = (text) => text
  .replace(/https?:\/\/\S+/g, 'link')
  .replace(/[*_~`]/g, '')
  .replace(/^\s*[-•]\s+/gm, '')
  .replace(/\s+/g, ' ')
  .trim();

function toOpus(pcm, rate) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-v', 'error', '-f', 's16le', '-ar', String(rate), '-ac', '1', '-i', 'pipe:0', '-c:a', 'libopus', '-b:a', '32k', '-f', 'ogg', 'pipe:1']);
    const out = [];
    let err = '';
    ff.stdout.on('data', (c) => out.push(c));
    ff.stderr.on('data', (c) => { err += c; });
    ff.on('error', (e) => reject(new Error(`ffmpeg unavailable: ${e.message}`)));
    ff.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg exited ${code}: ${err.slice(0, 200)}`))));
    ff.stdin.on('error', () => {}); // surfaced through the close handler
    ff.stdin.end(pcm);
  });
}

/** Returns an OGG/Opus Buffer, or null if the text is empty or too long to be worth speaking. Throws on API errors. */
async function speak(text) {
  const clean = speakable(text);
  if (!clean || clean.length > MAX_CHARS) return null;
  let res;
  for (let attempt = 0; attempt < 2; attempt++) {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text: clean }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } } },
      }),
    });
    if (res.ok || (res.status !== 500 && res.status !== 503)) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (!res.ok) throw new Error(`Gemini TTS ${res.status} ${(await res.text()).slice(0, 200)}`);
  const inline = (await res.json()).candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
  if (!inline?.data) throw new Error('Gemini TTS returned no audio');
  const rate = Number(/rate=(\d+)/.exec(inline.mimeType || '')?.[1]) || 24000;
  return toOpus(Buffer.from(inline.data, 'base64'), rate);
}

module.exports = { speak };
