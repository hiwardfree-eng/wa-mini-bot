/**
 * wa-mini-bot — WhatsApp mini bot open source
 * ------------------------------------------------------------------
 * - Anti-detección: emula cliente Mac OS / Safari (bypass "Mac").
 * - Anti-desconexión: reconexión automática con backoff + presencia invisible.
 * - Owner auto-detectado: el número que ESCANEA el QR es rango DIOS.
 *   También el OWNER_NUMBER de .env (comando .jefe).
 * - Sin APIs externas. Media local vía ffmpeg (opcional).
 *
 * Licencia MIT. Úsalo bajo tu responsabilidad.
 */
import 'dotenv/config';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { spawnSync } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
} from '@whiskeysockets/baileys';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── CONFIG ─────────────────────────────────────────────────────────
const PREFIX = process.env.PREFIX || '.';
const OWNER_NUMBER = (process.env.OWNER_NUMBER || '').replace(/\D/g, '');
const REPO_URL = process.env.REPO_URL || 'https://github.com/<tu-usuario>/wa-mini-bot';
const AUTH_DIR = join(__dirname, 'auth');
const DATA_DIR = join(__dirname, 'data');
const TMP_DIR = join(__dirname, 'tmp');

for (const d of [AUTH_DIR, DATA_DIR, TMP_DIR]) if (!existsSync(d)) mkdirSync(d, { recursive: true });

const log = pino({ level: 'silent' }); // silencia el ruido interno de Baileys
const say = (...a) => console.log('[bot]', ...a);

let sock = null;
let linkedNumber = '';       // el número que vinculó (DIOS al conectar)
const bootTime = Date.now();
let reconnectDelay = 3000;

// estados en memoria (no se suben a ningún lado)
const afk = new Map();                  // jid -> { ts, reason }
const spamCd = new Map();               // jid -> ts
const stickerBanUsers = new Map();      // groupJid -> Set(normalizedJid)
const stickerBanGroup = new Set();      // groupJid (todo el grupo sin stickers)

// ─── UTILIDADES ─────────────────────────────────────────────────────
const digits = (s = '') => String(s).replace(/\D/g, '');

function isGod(jid = '') {
  const n = digits(jid.split('@')[0].split(':')[0]);
  if (!n) return false;
  if (linkedNumber && n === linkedNumber) return true;
  if (OWNER_NUMBER && (n === OWNER_NUMBER || n.endsWith(OWNER_NUMBER) || OWNER_NUMBER.endsWith(n))) return true;
  return false;
}

function unwrap(msg) {
  let m = msg.message || {};
  m = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.viewOnceMessageV2?.message || m;
  const text =
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    '';
  return { m, text };
}

const fmtNum = (n = '') => {
  const d = digits(n);
  if (d.length === 11 && d.startsWith('1')) return `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  return '+' + d;
};

const secs = (ms) => Math.max(0, Math.round(ms / 1000));
const uptime = () => {
  const s = secs(Date.now() - bootTime);
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`;
};

async function isGroupAdmin(groupJid, jid) {
  try {
    const meta = await sock.groupMetadata(groupJid);
    return meta.participants.some((p) => digits(p.id) === digits(jid) && p.admin);
  } catch { return false; }
}

const hasFfmpeg = () => !spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).error;

// ─── CONEXIÓN ───────────────────────────────────────────────────────
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  sock = makeWASocket({
    auth: state,
    logger: log,
    // ── BYPASS MAC: WhatsApp ve un Mac + Safari ──
    browser: ['Mac OS', 'Safari', '14.4.1'],
    // ── ANTI-DETECCIÓN: invisible por defecto ──
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    // ── ANTI-DESCONEXIÓN ──
    retryRequestDelayMs: 2500,
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 25000,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      if (!existsSync(join(__dirname, 'qr.txt'))) {
        say('Escanea este QR: WhatsApp > Dispositivos vinculados > Vincular dispositivo');
      }
      try { writeFileSync(join(__dirname, 'qr.txt'), qr); } catch {}
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      reconnectDelay = 3000;
      const id = sock.user?.id || '';
      linkedNumber = digits(id.split('@')[0].split(':')[0]);
      say(`Conectado como ${fmtNum(linkedNumber)} — rango DIOS 👑`);
      if (OWNER_NUMBER) say(`JEFE extra: ${fmtNum(OWNER_NUMBER)}`);
      sock.sendPresenceUpdate('unavailable').catch(() => {});
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      say(`Cerrado (${code ?? '?'}). ` + (loggedOut ? 'Sesión cerrada — borra auth/ y vuelve a escanear.' : `Reconectando en ${reconnectDelay / 1000}s...`));
      if (loggedOut) return;
      setTimeout(() => startBot().catch((e) => say('Reconexión falló:', e.message)), reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try { await handleMessage(msg); } catch (e) { say('Error manejando mensaje:', e.message); }
    }
  });

  return sock;
}

// ─── STICKERBAN: borra stickers prohibidos ──────────────────────────
async function enforceStickerBan(msg) {
  const from = msg.key.remoteJid;
  const sponsor = msg.key.participant || from;
  const n = digits(sponsor);
  if (!from?.endsWith('@g.us')) return;
  const bannedUser = stickerBanUsers.get(from)?.has(n);
  const bannedGroup = stickerBanGroup.has(from);
  if (!bannedUser && !bannedGroup) return;
  try {
    await sock.sendMessage(from, { delete: { remoteJid: from, id: msg.key.id, participant: msg.key.participant } });
    say(`🧹 sticker borrado (stickerban) en ${from}`);
  } catch {}
}

// ─── COMANDOS ───────────────────────────────────────────────────────
const HELP = `*wa-mini-bot* — ${PREFIX} es el prefijo

*Generales*
${PREFIX}help, menu — esta ayuda
${PREFIX}ping — pong + latencia
${PREFIX}info — info del bot
${PREFIX}uptime — tiempo online
${PREFIX}jefe, creador, owner — quién manda 👑
${PREFIX}quien — tu rango aquí
${PREFIX}git — link del repo
${PREFIX}calc <expr> — calculadora (ej: ${PREFIX}calc 2*pi*5)
${PREFIX}b64 <texto> — codificar en base64 (${PREFIX}b64 -d para decodificar)
${PREFIX}wame — tu link de WhatsApp
${PREFIX}todo add|list|del — mini lista de tareas
${PREFIX}afk <razón> — modo ausente

*Media (requiere ffmpeg)*
${PREFIX}sticker — imagen/video → sticker (responde)
${PREFIX}toaudio — video → audio mp3 (responde)
${PREFIX}togif — video → gif (responde)
${PREFIX}ver — reenvía la media en grande (responde)

*Grupos*
${PREFIX}admins — lista admins
${PREFIX}link — link de invitación (admin)
${PREFIX}tagall <msg> — menciona a todos (admin)
${PREFIX}stickerban — sin stickers en el grupo (admin)
${PREFIX}stickerban @user — borra stickers de ese user (admin)
${PREFIX}mute / unmute — silenciar grupo (admin)
${PREFIX}ban @user — expulsar (admin)
${PREFIX}promote @user — dar admin (admin)
${PREFIX}demote @user — quitar admin (admin)

*Solo DIOS 👑*
${PREFIX}spam <n> <msg> — repite un mensaje (máx 20, cooldown)
${PREFIX}grupos — lista todos los grupos
${PREFIX}broadcast <msg> — mensaje a todos los grupos
${PREFIX}leave — el bot sale del grupo`;

async function handleMessage(msg) {
  const from = msg.key.remoteJid;
  if (!from || from === 'status@broadcast') return;

  const isGroup = from.endsWith('@g.us');
  const sender = isGroup ? msg.key.participant : from;
  const { m, text } = unwrap(msg);
  const god = isGod(sender);

  // stickerban: borra stickers prohibidos antes de procesar
  if (m.stickerMessage) await enforceStickerBan(msg);

  // ── AFK: responde una vez si te escriben estando ausente ──
  if (!text?.startsWith(PREFIX) && !m.stickerMessage) {
    for (const [jid, st] of afk) {
      const isTarget =
        (!isGroup && digits(from) === jid) ||
        (isGroup && mentioned.some((x) => digits(x) === jid));
      if (!isTarget) continue;
      const key = from + ':' + jid;
      if (st.notified?.has(key)) break;
      st.notified = st.notified || new Set();
      st.notified.add(key);
      const mins = Math.floor((Date.now() - st.ts) / 60000);
      sock.sendMessage(from, {
        text: `🤖 *AFK* — @${jid} está ausente (${mins}m): ${st.reason || 'sin razón'}\nTe responde cuando vuelva.`,
        mentions: [jid + '@s.whatsapp.net'],
      }).catch(() => {});
      break;
    }
  }

  if (!text || !text.startsWith(PREFIX)) return;

  const [rawCmd, ...args] = text.slice(PREFIX.length).trim().split(/\s+/);
  const cmd = rawCmd.toLowerCase();
  const arg = args.join(' ');
  const ctx = msg.message?.extendedTextMessage?.contextInfo || {};
  const mentioned = ctx.mentionedJid || [];
  const target = mentioned[0] || ctx.participant;
  say(`[${fmtNum(sender)}${god ? ' 👑' : ''}] ${cmd} ${isGroup ? '(grupo)' : '(privado)'}`);

  const reply = (t) => {
    try { sock.sendPresenceUpdate('available', from).catch(() => {}); } catch {}
    return sock.sendMessage(from, { text: t }, { quoted: msg });
  };

  switch (cmd) {
    case 'help':
    case 'menu':
      return reply(HELP);

    case 'ping': {
      const t0 = Date.now();
      const pong = await sock.sendMessage(from, { text: '🏓 pong' }, { quoted: msg });
      return sock.sendMessage(from, { text: `🏓 pong — ${Date.now() - t0}ms`, edit: pong.key });
    }

    case 'info':
      return reply(
        `*wa-mini-bot* v2.0.0\n` +
        `Uptime: ${uptime()}\n` +
        `Vinculado: ${linkedNumber ? fmtNum(linkedNumber) : '?'}\n` +
        `Tu rango: ${god ? '👑 DIOS' : 'usuario'}\n` +
        `Anti-detección: Mac OS / Safari\n` +
        `Reconexión automática: activa\n` +
        `Comandos: ${PREFIX}help`
      );

    case 'uptime':
      return reply(`🕐 Online: ${uptime()}`);

    case 'jefe':
    case 'creador':
    case 'owner':
      return reply(
        `👑 *JEFE*\n` +
        (OWNER_NUMBER ? `${fmtNum(OWNER_NUMBER)}\n` : `(sin OWNER_NUMBER en .env)\n`) +
        `Vinculado actual: ${linkedNumber ? fmtNum(linkedNumber) : '?'}\n\n` +
        (god ? 'Tú tienes rango *DIOS*. 😎' : 'Tú no eres el jefe, tranquilo.')
      );

    case 'quien':
    case 'quiensoy':
      return reply(
        god
          ? `👑 Tú eres el DIOS de este bot. ${linkedNumber === digits(sender) ? '(el número vinculado)' : '(número del .jefe)'}`
          : `👤 Usuario normal. El dios aquí es ${fmtNum(linkedNumber || OWNER_NUMBER)}.`
      );

    case 'git':
    case 'repo':
      return reply('📦 Repo: https://github.com/tilinx-lab/wa-mini-bot\n(Súbelo con tu propia cuenta)');

    // ─── calculadora segura (solo expresiones, sin eval de código) ───
    case 'calc': {
      if (!arg) return reply(`Uso: ${PREFIX}calc <expr> — ej: ${PREFIX}calc (4+5)*2`);
      if (!/^[\d\s+\-*/().,%^]+$/.test(arg)) return reply('⚠️ Solo números y operadores básicos.');
      try {
        const safe = arg.replace(/\^/g, '**');
        const f = new Function('Math', `return (${safe})`);
        const r = f(Math);
        if (typeof r !== 'number' || !isFinite(r)) return reply('⚠️ Resultado no válido.');
        return reply(`🧮 ${arg} = ${+r.toFixed(6)}`);
      } catch { return reply('⚠️ Expresión inválida.'); }
    }

    case 'b64': {
      const [mode, ...rest] = args;
      const payload = mode === '-d' || mode === 'dec' ? rest.join(' ') : args.join(' ');
      if (!payload) return reply(`Uso: ${PREFIX}b64 <texto> | ${PREFIX}b64 -d <base64>`);
      try {
        return reply(mode === '-d' || mode === 'dec' ? Buffer.from(payload, 'base64').toString('utf8') : Buffer.from(payload).toString('base64'));
      } catch (e) { return reply('⚠️ ' + e.message); }
    }

    case 'wame': {
      const n = digits(sender);
      return reply(`🔗 https://wa.me/${n}`);
    }

    case 'afk': {
      if (!arg) { afk.delete(digits(sender)); return reply('👋 Fuera del modo AFK.'); }
      afk.set(digits(sender), { ts: Date.now(), reason: arg, notified: new Set() });
      return reply(`🤖 AFK activado: *${arg}*\nTe escriban donde sea, respondo por ti.`);
    }

    case 'todo': {
      const file = join(DATA_DIR, `todo-${digits(sender)}.json`);
      const load = () => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return []; } };
      const save = (t) => writeFileSync(file, JSON.stringify(t, null, 2));
      const [sub, ...restArgs] = args;
      const rest = restArgs.join(' ');
      if (sub === 'add' && rest) { const t = load(); t.push(rest); save(t); return reply(`✅ Tarea ${t.length}: ${rest}`); }
      if (sub === 'del') {
        const i = parseInt(rest, 10);
        if (!i) return reply(`Uso: ${PREFIX}todo del <número>`);
        const t = load();
        if (!t[i - 1]) return reply('⚠️ No existe esa tarea.');
        const removed = t.splice(i - 1, 1)[0]; save(t);
        return reply(`🗑️ Borrada: ${removed}`);
      }
      if (sub === 'list' || sub === 'show' || !sub) {
        const t = load();
        if (!t.length) return reply('📝 Lista vacía. Añade con: ' + PREFIX + 'todo add <tarea>');
        return reply('📝 *Tus tareas:*\n' + t.map((x, i) => `${i + 1}. ${x}`).join('\n'));
      }
      return reply(`Uso: ${PREFIX}todo add|list|del`);
    }

    // ─── MEDIA (ffmpeg) ───────────────────────────────────────────
    case 'sticker':
    case 's':
    case 'toaudio':
    case 'togif':
    case 'ver': {
      const q = ctx.quotedMessage || {};
      const mediaMsg = q.imageMessage || q.videoMessage || m.imageMessage || m.videoMessage;
      if (!mediaMsg) return reply(`Responde a una imagen/video con ${PREFIX}${cmd}`);
      const src = { key: { ...msg.key, id: ctx.stanzaId || msg.key.id, remoteJid: from }, message: mediaMsg ? (q.imageMessage || q.videoMessage ? q : msg.message) : msg.message };

      if (cmd === 'ver') {
        try {
          const buf = await downloadMediaMessage(src, 'buffer', {}, { logger: log, reuploadRequest: sock.updateMediaMessage });
          const isImg = !!(q.imageMessage || m.imageMessage);
          const ext = isImg ? 'png' : 'mp4';
          await sock.sendMessage(from, isImg ? { image: buf } : { video: buf }, { quoted: msg });
          return;
        } catch (e) { return reply('No pude reenviar: ' + e.message); }
      }

      if (!hasFfmpeg()) return reply('⚠️ Instala ffmpeg (https://ffmpeg.org) para este comando.');
      try {
        const buf = await downloadMediaMessage(src, 'buffer', {}, { logger: log, reuploadRequest: sock.updateMediaMessage });
        const out = join(TMP_DIR, `m_${Date.now()}.`);
        const res =
          cmd === 'sticker' || cmd === 's' ? toSticker(buf, !!mediaMsg.videoMessage, out + 'webp')
          : cmd === 'toaudio' ? toAudio(buf, out + 'mp3')
          : cmd === 'togif' ? toGif(buf, out + 'gif')
          : null;
        if (res !== true) return reply(`⚠️ Falla: ${res}`);
        const payload =
          cmd === 'sticker' || cmd === 's' ? { sticker: readFileSync(out + 'webp') }
          : cmd === 'toaudio' ? { audio: readFileSync(out + 'mp3'), mimetype: 'audio/mpeg', ptt: true }
          : cmd === 'togif' ? { video: readFileSync(out + 'gif'), gifPlayback: true }
          : null;
        await sock.sendMessage(from, payload, { quoted: msg });
      } catch (e) { return reply('Error: ' + e.message); }
      return;
    }

    // ─── GRUPOS ───────────────────────────────────────────────────
    case 'admins': {
      if (!isGroup) return reply('Solo en grupos.');
      const meta = await sock.groupMetadata(from);
      const admins = meta.participants.filter((p) => p.admin);
      return sock.sendMessage(from, { text: `*Admins de ${meta.subject}:*\n` + (admins.map((p) => `• @${p.id.split('@')[0]}`).join('\n') || 'ninguno'), mentions: admins.map((p) => p.id) });
    }

    case 'link': {
      if (!isGroup) return reply('Solo en grupos.');
      if (!god && !(await isGroupAdmin(from, sender))) return reply('🚫 Solo admins.');
      try { return reply(`https://chat.whatsapp.com/${await sock.groupInviteCode(from)}`); }
      catch { return reply('No pude obtener el link (¿soy admin?).'); }
    }

    case 'tagall':
    case 'hidetag': {
      if (!isGroup) return reply('Solo en grupos.');
      if (!god && !(await isGroupAdmin(from, sender))) return reply('🚫 Solo admins.');
      const meta = await sock.groupMetadata(from);
      return sock.sendMessage(from, { text: `📣 ${arg || 'etiquetados'}\n` + meta.participants.map((p) => `@${p.id.split('@')[0]}`).join(' '), mentions: meta.participants.map((p) => p.id) });
    }

    case 'stickerban': {
      if (!isGroup) return reply('Solo en grupos.');
      if (!god && !(await isGroupAdmin(from, sender))) return reply('🚫 Solo admins.');
      if (mentioned[0]) {
        const bannedUser = digits(mentioned[0]);
        const s = stickerBanUsers.get(from) || new Set();
        if (s.has(bannedUser)) s.delete(bannedUser); else s.add(bannedUser);
        stickerBanUsers.set(from, s);
        return reply(`🧹 Stickers de @${mentioned[0].split('@')[0]}: ${s.has(bannedUser) ? 'PROHIBIDOS' : 'permitidos'}.`);
      }
      if (stickerBanGroup.has(from)) { stickerBanGroup.delete(from); return reply('🧹 Stickers del grupo: permitidos.'); }
      stickerBanGroup.add(from);
      return reply('🧹 Stickers del grupo: PROHIBIDOS (se borran solos).');
    }

    case 'mute':
    case 'unmute': {
      if (!isGroup) return reply('Solo en grupos.');
      if (!god && !(await isGroupAdmin(from, sender))) return reply('🚫 Solo admins.');
      try {
        await sock.groupSettingUpdate(from, cmd === 'mute' ? 'announcement' : 'not_announcement');
        return reply(cmd === 'mute' ? '🔇 Grupo silenciado.' : '🔊 Grupo abierto.');
      } catch { return reply('No pude (¿soy admin?).'); }
    }

    case 'ban':
    case 'kick':
    case 'promote':
    case 'demote': {
      if (!isGroup) return reply('Solo en grupos.');
      if (!god && !(await isGroupAdmin(from, sender))) return reply('🚫 Solo admins.');
      if (!target) return reply(`Menciona a alguien: ${PREFIX}${cmd} @user`);
      if (isGod(target)) return reply('🚫 No puedo tocar a un dios.');
      const action = cmd === 'promote' ? 'promote' : cmd === 'demote' ? 'demote' : 'remove';
      try {
        await sock.groupParticipantsUpdate(from, [target], action);
        return reply(action === 'remove' ? '✅ Expulsado.' : action === 'promote' ? '✅ Ahora es admin.' : '✅ Admin removido.');
      } catch (e) { return reply('No pude: ' + e.message); }
    }

    // ─── SOLO DIOS 👑 ─────────────────────────────────────────────
    case 'spam': {
      if (!god) return reply('🚫 Solo el jefe.');
      const n = parseInt(arg.split(' ')[0], 10);
      const rest = arg.split(' ').slice(1).join(' ');
      const source = ctx.quotedMessage?.conversation || ctx.quotedMessage?.extendedTextMessage?.text || rest;
      if (!n || n < 1 || n > 20) return reply('⚠️ Uso: ' + PREFIX + 'spam <1-20> <mensaje o responde a uno>');
      if (!source) return reply('⚠️ Pon el mensaje o responde a uno.');
      const last = spamCd.get(sender) || 0;
      if (Date.now() - last < 30000) return reply('⏳ Cooldown: espera 30s entre spams.');
      spamCd.set(sender, Date.now());
      say(`🖨️ spam x${n} de ${fmtNum(sender)}`);
      for (let i = 0; i < n; i++) { await sock.sendMessage(from, { text: source }); await new Promise((r) => setTimeout(r, 900)); }
      return;
    }

    case 'grupos':
    case 'groups': {
      if (!god) return reply('🚫 Solo el jefe.');
      const all = await sock.groupFetchAllParticipating();
      return reply(`*Grupos (${Object.keys(all).length}):*\n` + Object.values(all).map((g) => `• ${g.subject} (${g.participants?.length ?? '?'})`).join('\n'));
    }

    case 'broadcast':
    case 'bc': {
      if (!god) return reply('🚫 Solo el jefe.');
      if (!arg) return reply(`Uso: ${PREFIX}broadcast <mensaje>`);
      // ⚠️ Cuidado con el spam al broadcast: WhatsApp puede limitar el número.
      const all = await sock.groupFetchAllParticipating();
      let ok = 0;
      for (const g of Object.values(all)) {
        try { await sock.sendMessage(g.id, { text: `📢 ${arg}` }); ok++; } catch {}
        await new Promise((r) => setTimeout(r, 1200));
      }
      return reply(`📢 Enviado a ${ok}/${Object.keys(all).length} grupos.`);
    }

    case 'leave': {
      if (!god) return reply('🚫 Solo el jefe.');
      if (!isGroup) return reply('Solo en grupos.');
      await reply('👋 Me voy.');
      return sock.groupLeave(from);
    }

    default:
      return; // comando desconocido: silencio
  }
}

// ─── FFMPEG helpers ─────────────────────────────────────────────────
function ff(inputBuf, inPath, outPath, args) {
  writeFileSync(inPath, inputBuf);
  const r = spawnSync('ffmpeg', ['-y', '-i', inPath, ...args, outPath], { encoding: 'utf8' });
  if (r.error) return 'ffmpeg no está instalado o no está en el PATH';
  if (r.status !== 0) return (r.stderr || '').trim().split('\n').slice(-2).join(' ').slice(0, 300);
  return true;
}

function toSticker(buf, isVideo, outPath) {
  const inPath = outPath.replace(/\.webp$/, isVideo ? '_in.mp4' : '_in.img');
  const vf = isVideo
    ? 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2,fps=12'
    : 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2,format=rgba';
  const args = ['-vf', vf];
  if (isVideo) args.push('-t', '3', '-loop', '0', '-an');
  else args.push('-frames:v', '1');
  args.push('-c:v', 'libwebp', '-q:v', '70');
  return ff(buf, inPath, outPath, args);
}

function toAudio(buf, outPath) {
  const inPath = outPath.replace(/\.mp3$/, '_in.mp4');
  return ff(buf, inPath, outPath, ['-vn', '-c:a', 'libmp3lame', '-q:a', '4']);
}

function toGif(buf, outPath) {
  const inPath = outPath.replace(/\.gif$/, '_in.mp4');
  return ff(buf, inPath, outPath, ['-vf', 'fps=12,scale=320:-1:flags=lanczos', '-loop', '0']);
}

// ─── ARRANQUE ───────────────────────────────────────────────────────
say('wa-mini-bot arrancando...');
say(`Prefijo: "${PREFIX}"  |  Jefe: ${OWNER_NUMBER ? fmtNum(OWNER_NUMBER) : '(numero que vincule)'}`);
startBot().catch((e) => { say('FATAL:', e.message); process.exit(1); });

process.on('uncaughtException', (e) => say('Uncaught:', e.message));
process.on('unhandledRejection', (e) => say('Unhandled:', e?.message || e));