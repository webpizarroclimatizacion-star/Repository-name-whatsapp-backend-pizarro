require("dotenv").config();

const express = require("express");
const cors = require("cors");
const qrcode = require("qrcode");
const axios = require("axios");
const { Client, LocalAuth } = require("whatsapp-web.js");
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection capturada:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception capturada:", err);
});
const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "cambiar_esta_clave_segura";
const BASE44_WEBHOOK_URL = process.env.BASE44_WEBHOOK_URL || "";
const BASE44_STATUS_WEBHOOK_URL = process.env.BASE44_STATUS_WEBHOOK_URL || "";

const sessions = new Map();

function requireApiKey(req, res, next) {
  const key = req.headers["x-api-key"];
  if (!key || key !== API_KEY) {
    return res.status(401).json({ ok: false, error: "API key inválida o faltante" });
  }
  next();
}

function normalizePhone(phone) {
  if (!phone) return "";
  let cleaned = String(phone).replace(/[^\d]/g, "");

  // Argentina: si viene 381xxxxxxx, agregar 549
  if (cleaned.length === 10 && !cleaned.startsWith("54")) {
    cleaned = "549" + cleaned;
  }

  // si viene 54381..., para celular suele ser 549381...
  if (cleaned.startsWith("54") && !cleaned.startsWith("549") && cleaned.length >= 12) {
    cleaned = "549" + cleaned.slice(2);
  }

  return cleaned;
}

function getSession(sessionId) {
  return sessions.get(sessionId);
}

async function notifyBase44Message(payload) {
  if (!BASE44_WEBHOOK_URL) return;
  try {
    await axios.post(BASE44_WEBHOOK_URL, payload, {
      headers: { "x-api-key": API_KEY }
    });
  } catch (err) {
    console.error("Error notificando mensaje a Base44:", err.message);
  }
}

async function notifyBase44Status(payload) {
  if (!BASE44_STATUS_WEBHOOK_URL) return;
  try {
    await axios.post(BASE44_STATUS_WEBHOOK_URL, payload, {
      headers: { "x-api-key": API_KEY }
    });
  } catch (err) {
    console.error("Error notificando estado a Base44:", err.message);
  }
}

async function createClient(sessionId, sucursalId) {
  if (sessions.has(sessionId)) return sessions.get(sessionId);

  const state = {
    sessionId,
    sucursalId,
    status: "initializing",
    qr: null,
    client: null,
    number: null,
    lastActivity: null,
    error: null
  };

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: sessionId }),
    puppeteer: {
  headless: true,
  protocolTimeout: 120000,
  timeout: 120000,
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-accelerated-2d-canvas",
    "--no-first-run",
    "--no-zygote",
    "--disable-gpu"
  ]
}
  });

  state.client = client;
  sessions.set(sessionId, state);

  client.on("qr", async (qr) => {
    try {
      state.qr = await qrcode.toDataURL(qr);
      state.status = "waiting_scan";
      state.lastActivity = new Date().toISOString();
      console.log(`QR generado para sesión ${sessionId}`);
    } catch (err) {
      state.error = err.message;
      state.status = "error";
    }
  });

  client.on("ready", async () => {
    state.status = "connected";
    state.qr = null;
    state.lastActivity = new Date().toISOString();

    try {
      const info = client.info;
      state.number = info?.wid?.user || null;
    } catch (_) {}

    console.log(`WhatsApp conectado: ${sessionId}`);
  });

  client.on("authenticated", () => {
    state.status = "authenticated";
    state.lastActivity = new Date().toISOString();
    console.log(`Sesión autenticada: ${sessionId}`);
  });

  client.on("auth_failure", (msg) => {
    state.status = "auth_failure";
    state.error = msg;
    console.error(`Fallo de autenticación ${sessionId}:`, msg);
  });

  client.on("disconnected", (reason) => {
    state.status = "disconnected";
    state.error = reason;
    state.qr = null;
    console.log(`Sesión desconectada ${sessionId}:`, reason);
  });

  client.on("message", async (message) => {
    state.lastActivity = new Date().toISOString();

    const from = message.from || "";
    const isGroup = from.endsWith("@g.us");
    if (isGroup) return;

    const phone = from.replace("@c.us", "");

    const payload = {
      session_id: sessionId,
      sucursal_id: sucursalId,
      message_id: message.id?._serialized,
      telefono_cliente: phone,
      nombre_perfil_whatsapp: message._data?.notifyName || "",
      mensaje: message.body || "",
      tipo_mensaje: message.type || "text",
      fecha_hora: new Date(Number(message.timestamp) * 1000).toISOString(),
      direccion: "Entrante"
    };

    await notifyBase44Message(payload);
  });

  client.on("message_ack", async (message, ack) => {
    const statuses = {
      0: "pendiente",
      1: "enviado",
      2: "entregado",
      3: "leido",
      4: "reproducido"
    };

    await notifyBase44Status({
      session_id: sessionId,
      message_id: message.id?._serialized,
      estado: statuses[ack] || "desconocido",
      fecha_hora: new Date().toISOString()
    });
  });

  await client.initialize();
  return state;
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    name: "WhatsApp QR Backend",
    endpoints: [
      "POST /generate-qr",
      "POST /send-message",
      "POST /send-campaign",
      "POST /disconnect-session",
      "GET /session-status/:id",
      "GET /ping"
    ]
  });
});

app.get("/ping", requireApiKey, (req, res) => {
  res.json({ ok: true, status: "online", time: new Date().toISOString() });
});

app.post("/generate-qr", requireApiKey, async (req, res) => {
  try {
    const { session_id, sucursal_id, nombre_sesion } = req.body;

    if (!session_id) {
      return res.status(400).json({ ok: false, error: "session_id es obligatorio" });
    }

    let session = getSession(session_id);
    if (!session) {
      session = await createClient(session_id, sucursal_id || nombre_sesion || "default");
    }

    return res.json({
      ok: true,
      session_id,
      status: session.status,
      qr_code_base64: session.qr,
      number: session.number,
      last_activity: session.lastActivity,
      error: session.error
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/session-status/:id", requireApiKey, (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ ok: false, error: "Sesión no encontrada" });
  }

  res.json({
    ok: true,
    session_id: session.sessionId,
    sucursal_id: session.sucursalId,
    status: session.status,
    qr_code_base64: session.qr,
    number: session.number,
    last_activity: session.lastActivity,
    error: session.error
  });
});

app.post("/send-message", requireApiKey, async (req, res) => {
  try {
    const { session_id, telefono, phone, mensaje, message } = req.body;
    const session = getSession(session_id);

    if (!session || !session.client) {
      return res.status(404).json({ ok: false, error: "Sesión no encontrada" });
    }

    if (session.status !== "connected") {
      return res.status(400).json({ ok: false, error: "La sesión no está conectada" });
    }

    const cleanPhone = normalizePhone(telefono || phone);
    const text = mensaje || message;

    if (!cleanPhone || !text) {
      return res.status(400).json({ ok: false, error: "telefono y mensaje son obligatorios" });
    }

    const chatId = `${cleanPhone}@c.us`;
    const sent = await session.client.sendMessage(chatId, text);

    res.json({
      ok: true,
      message_id: sent.id?._serialized,
      telefono: cleanPhone,
      estado: "enviado"
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

app.post("/send-campaign", requireApiKey, async (req, res) => {
  try {
    const {
      session_id,
      clientes = [],
      mensaje,
      delay_min_ms = 12000,
      delay_max_ms = 35000
    } = req.body;

    const session = getSession(session_id);

    if (!session || !session.client) {
      return res.status(404).json({ ok: false, error: "Sesión no encontrada" });
    }

    if (session.status !== "connected") {
      return res.status(400).json({ ok: false, error: "La sesión no está conectada" });
    }

    if (!Array.isArray(clientes) || clientes.length === 0) {
      return res.status(400).json({ ok: false, error: "clientes debe ser una lista" });
    }

    res.json({
      ok: true,
      status: "campaign_started",
      total: clientes.length
    });

    for (const cliente of clientes) {
      try {
        const phone = normalizePhone(cliente.telefono || cliente.phone);
        if (!phone) continue;

        const personalMessage = String(mensaje || "")
          .replaceAll("{{nombre}}", cliente.nombre || "")
          .replaceAll("{{sucursal}}", cliente.sucursal || "");

        const sent = await session.client.sendMessage(`${phone}@c.us`, personalMessage);

        await notifyBase44Status({
          session_id,
          campaign_id: req.body.campaign_id || null,
          cliente_id: cliente.id || null,
          telefono: phone,
          message_id: sent.id?._serialized,
          estado: "enviado",
          fecha_hora: new Date().toISOString()
        });

        const delay = Math.floor(Math.random() * (delay_max_ms - delay_min_ms + 1)) + delay_min_ms;
        await sleep(delay);
      } catch (err) {
        await notifyBase44Status({
          session_id,
          campaign_id: req.body.campaign_id || null,
          cliente_id: cliente.id || null,
          telefono: cliente.telefono || cliente.phone,
          estado: "error",
          error_detalle: err.message,
          fecha_hora: new Date().toISOString()
        });
      }
    }
  } catch (err) {
    console.error(err);
  }
});
app.get("/chats/:session_id", requireApiKey, async (req, res) => {
  try {
    const sessionId = req.params.session_id;
    const session = getSession(sessionId);

    if (!session || !session.client) {
      return res.status(404).json({ ok: false, error: "Sesión no encontrada" });
    }

    if (session.status !== "connected") {
      return res.status(400).json({
        ok: false,
        error: "La sesión no está conectada",
        status: session.status
      });
    }

    await new Promise(resolve => setTimeout(resolve, 5000));

const state = await session.client.getState().catch(() => null);

if (state !== "CONNECTED") {
  return res.status(400).json({
    ok: false,
    error: "WhatsApp todavía no está completamente conectado",
    state
  });
}

let chats = [];

try {
  chats = await session.client.getChats();
} catch (err) {
  console.error("Error en getChats:", err.message);

  return res.status(500).json({
    ok: false,
    error: "No se pudieron cargar los chats. Esperá unos segundos y volvé a sincronizar.",
    detail: err.message
  });
}

const result = chats
  .filter(chat => !chat.isGroup)
  .map(chat => ({
    chat_id: chat.id?._serialized,
    nombre: chat.name || chat.id?.user || "",
    telefono: chat.id?.user || "",
    ultimo_mensaje: chat.lastMessage?.body || "",
    fecha_ultimo_mensaje: chat.timestamp
      ? new Date(chat.timestamp * 1000).toISOString()
      : null,
    cantidad_no_leidos: chat.unreadCount || 0,
    es_grupo: chat.isGroup || false,
    session_id: sessionId,
    sucursal: session.sucursalId || ""
  }));

    res.json({
      ok: true,
      session_id: sessionId,
      total: result.length,
      chats: result
    });
  } catch (err) {
    console.error("Error obteniendo chats:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.post("/disconnect-session", requireApiKey, async (req, res) => {
  try {
    const { session_id } = req.body;
    const session = getSession(session_id);

    if (!session || !session.client) {
      return res.status(404).json({ ok: false, error: "Sesión no encontrada" });
    }

    await session.client.logout().catch(() => {});
    await session.client.destroy().catch(() => {});
    sessions.delete(session_id);

    res.json({ ok: true, status: "disconnected" });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`WhatsApp QR Backend corriendo en puerto ${PORT}`);
});
