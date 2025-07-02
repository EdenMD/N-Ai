// --- Automatic Dependency Installation ---
const { execSync } = require('child_process');
const fs = require('fs');

const requiredPackages = [
  '@whiskeysockets/baileys',
  '@google/generative-ai',
  'pino-pretty',
  'qrcode-terminal'
];

console.log('Installing dependencies…');
try {
  if (!fs.existsSync('package.json')) {
    execSync('npm init -y', { stdio: 'inherit' });
  }
  execSync(`npm install ${requiredPackages.join(' ')}`, { stdio: 'inherit' });
  console.log('All dependencies ready.');
} catch (err) {
  console.error('Install error:', err.message);
  process.exit(1);
}

// --- Imports ---
const { makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } =
  require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const pino = require('pino');
const qrcode = require('qrcode-terminal');

// --- Configuration ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'AIzaSyA…'; 
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

const PERSONA_PROMPT = `
You are Nyasha Munyanyiwa, a 16-year-old boy in Magwegwe North, Zimbabwe.
Respond in a very human, teen-like style using as few words as possible.
Do not mention you’re a bot or use full sentences often.
Examples: "k", "lol", "yeah", "idk", "cool", "busy", "kinda".
`.trim();

// --- Connect to WhatsApp via Baileys ---
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`Using Baileys v${version}${isLatest ? ' (latest)' : ''}`);

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['NyashaBot', 'Chrome', '1.0.0']
  });

  sock.ev.on('connection.update', update => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('Scan this QR with WhatsApp on your phone:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed, reconnecting:', shouldReconnect);
      if (shouldReconnect) setTimeout(connectToWhatsApp, 5000);
    } else if (connection === 'open') {
      console.log('Connection opened! Nyasha is online!');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async m => {
    const msg = m.messages?.[0];
    if (!msg || msg.key.fromMe || m.type !== 'append') return;

    const sender = msg.key.remoteJid;
    const text =
      msg.message?.extendedTextMessage?.text ||
      msg.message?.conversation ||
      msg.message?.imageMessage?.caption ||
      msg.message?.videoMessage?.caption ||
      '';

    if (!text) return;
    console.log(`Received (${sender}): ${text}`);

    const prompt = `${PERSONA_PROMPT}\n\nUser: ${text}\nNyasha:`;
    try {
      const result = await model.generateContent(prompt);
      let reply = result?.response?.text?.().replace(/^Nyasha:\s*/i, '').trim();
      if (reply) {
        console.log(`Replying to ${sender}: ${reply}`);
        await sock.sendPresenceUpdate('composing', sender);
        await new Promise(r => setTimeout(r, Math.random() * 1000 + 500));
        await sock.sendMessage(sender, { text: reply });
        await sock.sendPresenceUpdate('paused', sender);
      }
    } catch (err) {
      console.error('Gemini API error:', err);
      await sock.sendPresenceUpdate('paused', sender);
    }
  });

  return sock;
}

// --- Start the bot ---
console.log('Starting Nyasha Bot…');
connectToWhatsApp().catch(err =>
  console.error('Fatal Error connecting to WhatsApp:', err)
);
