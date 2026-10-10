# wa-mini-bot

WhatsApp bot mini open source. Sin APIs externas, sin Python, un solo archivo.

- 🔇 **Anti-detección**: emula cliente **Mac OS / Safari** — WhatsApp no ve un script.
- 🔄 **Anti-desconexión**: reconexión automática con backoff + presencia invisible (aparece "desconectado").
- 👑 **Rango DIOS automático**: el número que **escanee el QR** es el dueño total, también dentro de los grupos. El `OWNER_NUMBER` de `.env` es jefe extra (comando `.jefe`).
- 📦 Sin APIs de pago. Media local vía **ffmpeg** (opcional).

## Requisitos

- **Node.js 18+** → https://nodejs.org (LTS)
- **ffmpeg** (opcional, para `.sticker`, `.toaudio`, `.togif`) → https://ffmpeg.org/download.html

## Instalación (Windows — 3 pasos)

```bat
:: 1. instala dependencias
install.bat

:: 2. configura tu número (opcional)
copy .env.example .env

:: 3. arranca
start.bat
```

O manual:

```bash
npm install
npm start
```

Aparece un **QR**. Escanéalo con WhatsApp > Dispositivos vinculados. **El número que escanee es el dueño (DIOS)**.

La sesión se guarda en `auth/` — no hace falta escanear de nuevo.

## Comandos

```
General      .help .ping .info .uptime .jefe .quien .git .calc .b64 .wame .todo .afk
Media        .sticker .toaudio .togif .ver
Grupos       .admins .link .tagall .stickerban .mute .unmute .ban .promote .demote
DIOS 👑      .spam .grupos .broadcast .leave
```

### DIOS

El número que vincula el QR → **rango dios** en privado y en todos los grupos (los comandos restringidos funcionan ahí). Además puedes fijar tu número en `.env`:

```env
OWNER_NUMBER=18494864629
```

## Comandos detallados

| Comando | Qué hace |
|---|---|
| `.sticker` | responde a imagen/video → sticker |
| `.toaudio` | responde a video → audio mp3 (audio de voz) |
| `.togif` | responde a video → GIF |
| `.ver` | reenvía la media en grande (imagen/video) |
| `.spam <1-20> <msg>` | repite mensaje (cooldown 30s) |
| `.stickerban` | modo grupo: borra stickers automáticamente |
| `.stickerban @user` | borra stickers solo de ese user |
| `.tagall <msg>` | menciona a todos |
| `.calc 2*pi*5` | calculadora (solo operadores seguros) |
| `.b64 ola` / `.b64 -d b2xh` | base64 encode/decode |
| `.todo add|list|del` | mini lista de tareas por usuario |
| `.afk <razón>` | modo ausente — responde por ti 1 vez por chat |
| `.mute` / `.unmute` | silencia / abre el grupo |
| `.ban` `.promote` `.demote` | expulsar / admin / quitar admin (menciona a alguien) |
| `.grupos` | lista todos los grupos del bot |
| `.broadcast <msg>` | envía a todos los grupos |
| `.leave` | el bot sale del grupo |

## Troubleshooting

**El QR no aparece / sale `405`**: versiones viejas de Baileys son rechazadas por WhatsApp. El proyecto fija `@whiskeysockets/baileys@7.0.0-rc14`, que funciona. Si WhatsApp vuelve a rechazar, actualiza: `npm install @whiskeysockets/baileys@latest`.

**"Sesión cerrada"**: WhatsApp cerró la sesión desde el teléfono. Borra `auth/` y escanea de nuevo.

**`.sticker` no funciona**: no está ffmpeg en el PATH.

**El bot se ve "desconectado" siempre**: es a propósito (anti-detección). Revisa que responda mandándole `.ping`.

## Seguridad

- `auth/` contiene tu sesión. **Nunca la subas a GitHub** (está en `.gitignore`).
- `.spam` y `.broadcast` tienen límites para no quemar el número.
- Este proyecto es para fines educativos. Usa WhatsApp responsablemente.

## Licencia

MIT. Hecho para la comunidad. 🐒