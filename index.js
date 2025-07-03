#!/usr/bin/env node

// Load env vars from .env
require('dotenv').config();

const path = require('path');
const fs = require('fs');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const {
  makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { PERSONA_PROMPT } = require('./config');

const STATE_FOLDER = path.join(__dirname, 'baileysauthinfo');

async function connectToWhatsApp() {
  // Ensure API key is set
  const apiKey = process.env.GEMINIAPIKEY;
  if (!apiKey) {
    console.error('❌ Missing GEMINIAPIKEY. Set it in .env or GitHub Secrets.');
    process.exit(1);
  }

  // Initialize Google Gemini client
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

  // Load or create auth state
  const { state, saveCreds } = await useMultiFileAuthState(STATE_FOLDER);

  // Fetch Baileys version
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`Using Baileys v${version}${isLatest ? '' : ' (not latest)'}`);

  // Create socket
  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'info' }),
    printQRInTerminal: true,
    browser: ['NyashaBot', 'Chrome', '1.0.0']
  });

  // Handle connection updates
  sock.ev.on('connection.update', update => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n🔗 Scan this QR code with WhatsApp:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const reason = DisconnectReason[code] || code;
      console.warn(`Connection closed: ${reason}`);

      // Attempt reconnect unless logged out
      if (reason !== DisconnectReason.loggedOut) {
        setTimeout(connectToWhatsApp, 5_000);
      } else {
        console.error('Logged out. Delete baileysauthinfo/ to start fresh.');
      }
    }

    if (connection === 'open') {
      console.log('✅ Connection opened! Nyasha is online!');
    }
  });

  // Persist credentials
  sock.ev.on('creds.update', saveCreds);

  // Handle incoming messages
  sock.ev.on('messages.upsert', async m => {
    try {
      const msg = m.messages?.[0];
      if (!msg || msg.key.fromMe || m.type !== 'append') return;

      const jid = msg.key.remoteJid;
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        '';

      if (!text.trim()) return;
      console.log(`📩 Received from ${jid}: ${text}`);

      // Build prompt
      const prompt = `${PERSONA_PROMPT}\n\nUser: ${text}\nNyasha:`;

      // Ask Gemini
      const result = await model.generateContent(prompt);
      let reply = result?.response?.text?.().replace(/^Nyasha:\s*/i, '').trim();

      if (!reply) {
        console.warn('⚠️ Gemini returned an empty reply');
        return;
      }

      console.log(`✏️ Replying to ${jid}: ${reply}`);
      await sock.sendPresenceUpdate('composing', jid);
      await new Promise(r => setTimeout(r, 500 + Math.random() * 1000));
      await sock.sendMessage(jid, { text: reply });
      await sock.sendPresenceUpdate('paused', jid);
    } catch (err) {
      console.error('❗ Error handling message:', err);
    }
  });

  return sock;
}

// Global error handlers
process.on('unhandledRejection', err => {
  console.error('Unhandled promise rejection:', err);
});
process.on('uncaughtException', err => {
  console.error('Uncaught exception:', err);
  process.exit(1);
});

// Start the bot
console.log('▶️ Starting Nyasha Bot...');
connectToWhatsApp().catch(err => {
  console.error('🚨 Fatal error:', err);
  process.exit(1);
});