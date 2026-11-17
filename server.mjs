/**
 * SUNDAY — local app server + Home Assistant proxy.
 * DURO Automation · Concept Automation
 *
 * Why a proxy: a browser cannot call Home Assistant directly (CORS), and we do
 * not want the long-lived token living in page storage. The token is held in
 * this process's memory only: never written to disk, never logged, never sent
 * back to the browser.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));
const HOST = process.env.HOST ?? "127.0.0.1";
const BASE_PORT = Number(process.env.PORT ?? 8000);
const PORT_ATTEMPTS = 12;
const MAX_BODY_BYTES = 32_768;
const HA_TIMEOUT_MS = 10_000;
const MAX_DEVICES = 8;

/** Domains we are willing to switch on and off. */
const CONTROLLABLE_DOMAINS = new Set(["light", "switch", "fan", "input_boolean"]);
const ALLOWED_SERVICES = new Set(["turn_on", "turn_off", "toggle"]);
const ENTITY_ID_PATTERN = /^[a-z_]+\.[a-z0-9_]+$/;

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".task": "application/octet-stream",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

/** In-memory only. Cleared on disconnect and on exit. */
let connection = null;

const httpError = (message, status = 400, hint = "") =>
  Object.assign(new Error(message), { status, hint });

/* ------------------------------------------------------------------ plumbing */

function sendJson(response, status, data) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  response.end(JSON.stringify(data));
}

function hostnameOf(hostHeader = "") {
  const value = String(hostHeader).trim();
  if (value.startsWith("[")) return value.slice(1, value.indexOf("]")).toLowerCase();
  return value.split(":")[0].toLowerCase();
}

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1", "0:0:0:0:0:0:0:1"]);

function isLoopbackHost(hostHeader) {
  return LOOPBACK_NAMES.has(hostnameOf(hostHeader));
}

/** Blocks other sites on the machine from driving this proxy. */
function isSameOriginRequest(request) {
  if (!isLoopbackHost(request.headers.host)) return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.host === request.headers.host && isLoopbackHost(parsed.host);
  } catch {
    return false;
  }
}

async function readJson(request) {
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) throw httpError("Request body is too large.", 413);
    chunks.push(chunk);
  }
  if (length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object") throw new Error("not an object");
    return parsed;
  } catch {
    throw httpError("Request body must be valid JSON.", 400);
  }
}

/* ---------------------------------------------------- Home Assistant client */

function normalizeHaUrl(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) throw httpError("Enter your Home Assistant address.", 400);
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    throw httpError(
      "That does not look like a valid address.",
      400,
      "Example: http://homeassistant.local:8123",
    );
  }
  if (url.username || url.password) {
    throw httpError("Remove the username and password from the address.", 400);
  }
  if (!url.port && url.protocol === "http:") url.port = "8123";
  return url.origin;
}

/** Turns a low-level network failure into something a person can act on. */
function describeTransportError(error, url) {
  const code = error?.cause?.code ?? error?.code ?? "";
  const host = (() => {
    try { return new URL(url).host; } catch { return url; }
  })();

  if (error?.name === "AbortError" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "ETIMEDOUT") {
    return httpError(`${host} did not answer in time.`, 504,
      "Check that the address and port are right and that this computer is on the same network as Home Assistant.");
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return httpError(`The name "${host}" could not be found on your network.`, 502,
      "Try your Home Assistant IP address instead, for example http://192.168.1.25:8123");
  }
  if (code === "ECONNREFUSED") {
    return httpError(`${host} refused the connection.`, 502,
      "Home Assistant may be on a different port. The usual one is 8123.");
  }
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") {
    return httpError(`${host} cannot be reached from this computer.`, 502,
      "Make sure both devices are on the same Wi-Fi or LAN.");
  }
  if (code === "ECONNRESET" || code === "EPIPE") {
    return httpError(`The connection to ${host} was closed unexpectedly.`, 502,
      "If Home Assistant uses HTTPS, use an https:// address.");
  }
  if (String(code).includes("CERT") || String(code).includes("SELF_SIGNED") ||
      code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || code === "ERR_TLS_CERT_ALTNAME_INVALID") {
    return httpError(`The HTTPS certificate for ${host} could not be verified.`, 502,
      "On your own network use the plain http:// address and port 8123 instead.");
  }
  return httpError(`Could not reach Home Assistant at ${host}.`, 502, code ? `Network error: ${code}` : "");
}

async function haFetch(path, options = {}, target = connection) {
  if (!target) throw httpError("Not connected to Home Assistant.", 409);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HA_TIMEOUT_MS);
  try {
    return await fetch(`${target.url}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${target.token}`,
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
    });
  } catch (error) {
    throw describeTransportError(error, target.url);
  } finally {
    clearTimeout(timeout);
  }
}

/** Maps Home Assistant HTTP statuses onto plain-language guidance. */
function haStatusError(status, what) {
  if (status === 401) {
    return httpError("Home Assistant rejected the access token.", 401,
      "Create a fresh long-lived access token in Home Assistant under your profile, Security, at the bottom of the page.");
  }
  if (status === 403) {
    return httpError("Home Assistant refused the request.", 403,
      "The token may belong to a user without access, or this computer's IP may be banned in Home Assistant.");
  }
  if (status === 404) {
    return httpError("Home Assistant answered, but its REST API was not found.", 502,
      "Check the address does not include a path, and that the api integration is enabled (default_config covers it).");
  }
  return httpError(`Home Assistant returned an error (${status}) while ${what}.`, 502);
}

async function haJson(path, options, target) {
  const response = await haFetch(path, options, target);
  if (!response.ok) throw haStatusError(response.status, `loading ${path}`);
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw httpError("Home Assistant sent a response this app could not read.", 502,
      "Make sure the address points at Home Assistant itself and not at a proxy or login page.");
  }
}

/* ------------------------------------------------------------ entity shaping */

const domainOf = (entityId) => String(entityId).split(".", 1)[0];

const COLOR_MODES = new Set(["hs", "rgb", "rgbw", "rgbww", "xy"]);

function describeEntity(entity) {
  const attributes = entity.attributes ?? {};
  const modes = Array.isArray(attributes.supported_color_modes) ? attributes.supported_color_modes : [];
  const domain = domainOf(entity.entity_id);
  return {
    entityId: entity.entity_id,
    domain,
    name: attributes.friendly_name || entity.entity_id.split(".")[1].replace(/_/g, " "),
    state: entity.state,
    available: entity.state !== "unavailable" && entity.state !== "unknown",
    brightness: Number.isFinite(attributes.brightness) ? attributes.brightness : null,
    supportsColor: domain === "light" && modes.some((mode) => COLOR_MODES.has(mode)),
    supportsBrightness: domain === "light" && modes.some((mode) => mode !== "onoff"),
    /* Which white the lamp can actually make. A dedicated white LED, or a
       tunable colour temperature, both beat mixing white out of red, green
       and blue — they are brighter and they are not faintly tinted. */
    supportsWhiteMode: domain === "light" && modes.includes("white"),
    supportsColorTemp: domain === "light" && modes.includes("color_temp"),
  };
}

async function loadStates(target) {
  const states = await haJson("/api/states", undefined, target);
  if (!Array.isArray(states)) {
    throw httpError("Home Assistant did not return a device list.", 502);
  }
  return states;
}

/* ----------------------------------------------------------------- endpoints */

/** Step 1: verify the address + token, then hand back the devices to choose from. */
async function handleConnect(request, response) {
  const body = await readJson(request);
  const url = normalizeHaUrl(body.url);
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token) {
    throw httpError("Enter a long-lived access token.", 400,
      "In Home Assistant open your profile, scroll to Security, and create a long-lived access token.");
  }
  if (/\s/.test(token)) {
    throw httpError("The access token contains spaces or line breaks.", 400, "Copy the token again without extra spaces.");
  }

  const candidate = { url, token, entityIds: [] };
  const api = await haJson("/api/", undefined, candidate);
  if (api?.message !== "API running.") {
    throw httpError("That address answered, but it is not the Home Assistant API.", 502,
      "Use the address you open Home Assistant with, including the port, and no extra path.");
  }

  const entities = (await loadStates(candidate))
    .filter((entity) => CONTROLLABLE_DOMAINS.has(domainOf(entity.entity_id)))
    .map(describeEntity)
    .sort((a, b) => a.name.localeCompare(b.name));

  if (entities.length === 0) {
    throw httpError("Connected, but no lights or switches were found.", 502,
      "This token's user may not have access to any devices in Home Assistant.");
  }

  // Keep the verified credentials, carrying over a device choice if it still exists.
  const known = new Set(entities.map((entity) => entity.entityId));
  const carried = (connection?.entityIds ?? []).filter((id) => known.has(id));
  connection = { url, token, entityIds: carried };

  sendJson(response, 200, { url, entities, entityIds: carried });
}

/** Step 2: remember which devices this app is allowed to control. */
async function handleSelectDevices(request, response) {
  if (!connection) throw httpError("Connect to Home Assistant first.", 409);
  const body = await readJson(request);
  const requested = Array.isArray(body.entityIds) ? body.entityIds : [];
  const entityIds = [...new Set(requested.filter((id) => typeof id === "string").map((id) => id.trim().toLowerCase()))];

  if (entityIds.length === 0) throw httpError("Choose at least one device to control.", 400);
  if (entityIds.length > MAX_DEVICES) throw httpError(`Choose up to ${MAX_DEVICES} devices.`, 400);
  if (entityIds.some((id) => !ENTITY_ID_PATTERN.test(id) || !CONTROLLABLE_DOMAINS.has(domainOf(id)))) {
    throw httpError("Only lights, switches, fans and toggle helpers can be controlled.", 400);
  }

  const byId = new Map((await loadStates(connection)).map((entity) => [entity.entity_id, entity]));
  const missing = entityIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw httpError(`Home Assistant does not have ${missing.join(", ")}.`, 400,
      "Pick the devices from the list so the IDs always match.");
  }

  connection.entityIds = entityIds;
  sendJson(response, 200, { entityIds, devices: entityIds.map((id) => describeEntity(byId.get(id))) });
}

async function handleStatus(response) {
  if (!connection) {
    sendJson(response, 200, { connected: false });
    return;
  }
  const byId = new Map((await loadStates(connection)).map((entity) => [entity.entity_id, entity]));
  const entities = [...byId.values()]
    .filter((entity) => CONTROLLABLE_DOMAINS.has(domainOf(entity.entity_id)))
    .map(describeEntity)
    .sort((a, b) => a.name.localeCompare(b.name));
  connection.entityIds = connection.entityIds.filter((id) => byId.has(id));
  sendJson(response, 200, {
    connected: true,
    url: connection.url,
    entityIds: connection.entityIds,
    entities,
    devices: connection.entityIds.map((id) => describeEntity(byId.get(id))),
  });
}

/** Live state of the chosen devices, for the dashboard poll. */
async function handleDeviceStates(response) {
  if (!connection) {
    sendJson(response, 200, { connected: false, devices: [] });
    return;
  }
  const byId = new Map((await loadStates(connection)).map((entity) => [entity.entity_id, entity]));
  sendJson(response, 200, {
    connected: true,
    devices: connection.entityIds.filter((id) => byId.has(id)).map((id) => describeEntity(byId.get(id))),
  });
}

function buildServiceData(domain, service, body) {
  const data = {};
  if (domain !== "light" || service === "turn_off") return data;
  if (Number.isFinite(body.brightness)) {
    data.brightness = Math.min(255, Math.max(1, Math.round(body.brightness)));
  }
  if (Array.isArray(body.rgb_color) && body.rgb_color.length === 3 &&
      body.rgb_color.every((value) => Number.isFinite(value) && value >= 0 && value <= 255)) {
    data.rgb_color = body.rgb_color.map((value) => Math.round(value));
  }
  /* A true white, where the lamp has one: `white` drives a dedicated white
     LED, `color_temp_kelvin` a tunable one. Both are brighter and cleaner
     than asking red, green and blue to add up to white. */
  if (Number.isFinite(body.white)) {
    data.white = Math.min(255, Math.max(1, Math.round(body.white)));
  }
  if (Number.isFinite(body.color_temp_kelvin)) {
    data.color_temp_kelvin = Math.min(10000, Math.max(1500, Math.round(body.color_temp_kelvin)));
  }
  if (Number.isFinite(body.transition)) {
    data.transition = Math.min(10, Math.max(0, body.transition));
  }
  return data;
}

/** Only on/off style services, only on devices the user explicitly picked. */
async function handleServiceCall(request, response, domain, service) {
  if (!connection) throw httpError("Connect to Home Assistant before controlling devices.", 409);
  if (!CONTROLLABLE_DOMAINS.has(domain) || !ALLOWED_SERVICES.has(service)) {
    throw httpError("That Home Assistant service is not allowed by this app.", 400);
  }

  const body = await readJson(request);
  const requested = Array.isArray(body.entity_id) ? body.entity_id : [body.entity_id].filter(Boolean);
  const entityIds = requested.filter((id) =>
    typeof id === "string" && connection.entityIds.includes(id) && domainOf(id) === domain);

  if (requested.length === 0) throw httpError("No device was named in the command.", 400);
  if (entityIds.length !== requested.length) {
    throw httpError("That command named a device this app is not set up to control.", 403);
  }

  const result = await haFetch(`/api/services/${domain}/${service}`, {
    method: "POST",
    body: JSON.stringify({ entity_id: entityIds, ...buildServiceData(domain, service, body) }),
  });
  if (!result.ok) {
    if (result.status === 401 || result.status === 403 || result.status === 404) {
      throw haStatusError(result.status, "sending the command");
    }
    const details = (await result.text()).slice(0, 200);
    throw httpError(`Home Assistant could not run that command (${result.status}).`, 502, details);
  }
  sendJson(response, 200, { ok: true, entityIds });
}

/* -------------------------------------------------------------- static files */

async function serveStatic(pathname, response, method) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendJson(response, 400, { error: "Invalid URL path." });
    return;
  }
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const filePath = resolve(ROOT, relative);
  if (filePath !== ROOT && !filePath.startsWith(`${ROOT}${sep}`)) {
    sendJson(response, 403, { error: "Forbidden." });
    return;
  }
  try {
    const contents = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(method === "HEAD" ? undefined : contents);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") {
      sendJson(response, 404, { error: "Not found." });
      return;
    }
    throw error;
  }
}

/* -------------------------------------------------------------------- router */

const server = createServer(async (request, response) => {
  let requestUrl;
  try {
    requestUrl = new URL(request.url, `http://${request.headers.host ?? `${HOST}:${BASE_PORT}`}`);
  } catch {
    sendJson(response, 400, { error: "Invalid request URL." });
    return;
  }

  if (!isSameOriginRequest(request)) {
    sendJson(response, 403, { error: "Requests must come from this app on this computer." });
    return;
  }

  try {
    const { pathname } = requestUrl;
    const method = request.method;

    if (method === "POST" && pathname === "/api/ha/connect") return void await handleConnect(request, response);
    if (method === "POST" && pathname === "/api/ha/devices") return void await handleSelectDevices(request, response);
    if (method === "GET" && pathname === "/api/ha/status") return void await handleStatus(response);
    if (method === "GET" && pathname === "/api/ha/states") return void await handleDeviceStates(response);
    if (method === "POST" && pathname === "/api/ha/disconnect") {
      connection = null;
      return void sendJson(response, 200, { ok: true });
    }

    const service = pathname.match(/^\/api\/ha\/services\/([a-z_]+)\/([a-z_]+)$/);
    if (method === "POST" && service) {
      return void await handleServiceCall(request, response, service[1], service[2]);
    }
    if (pathname.startsWith("/api/")) {
      return void sendJson(response, 404, { error: "Unknown local API endpoint." });
    }
    if (method === "GET" || method === "HEAD") {
      return void await serveStatic(pathname, response, method);
    }
    sendJson(response, 405, { error: "Method not allowed." });
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 502;
    sendJson(response, status, { error: error?.message ?? "Unexpected server error.", hint: error?.hint ?? "" });
  }
});

/* ------------------------------------------------------------------- startup */

function listenWithFallback(port, attemptsLeft) {
  server.once("error", (error) => {
    if (error.code === "EADDRINUSE" && attemptsLeft > 0) {
      console.warn(`Port ${port} is already in use — trying ${port + 1}.`);
      listenWithFallback(port + 1, attemptsLeft - 1);
      return;
    }
    if (error.code === "EADDRINUSE") {
      console.error(`\nCould not start: ports ${BASE_PORT}-${port} are all in use.`);
      console.error("Close the other copy of this app, or start it with a different port:\n  PORT=9000 node server.mjs\n");
    } else if (error.code === "EACCES") {
      console.error(`\nCould not start: permission denied for port ${port}. Try a port above 1024.\n`);
    } else {
      console.error(`\nCould not start the server: ${error.message}\n`);
    }
    process.exit(1);
  });

  server.listen(port, HOST, () => {
    console.log("\n  SUNDAY \u00b7 offline smart home assistant");
    console.log("  DURO Automation \u00b7 Concept Automation");
    console.log(`  Open  ->  http://${HOST}:${port}\n`);
    console.log("  Home Assistant tokens stay in this process's memory only.");
    console.log("  Press Ctrl+C to stop.\n");
  });
}

listenWithFallback(BASE_PORT, PORT_ATTEMPTS);

let stopping = false;
function stopServer() {
  if (stopping) process.exit(0);
  stopping = true;
  connection = null;
  console.log("\nStopping. Home Assistant credentials cleared.");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on("SIGINT", stopServer);
process.on("SIGTERM", stopServer);
process.on("unhandledRejection", (reason) => console.error("Unhandled rejection:", reason?.message ?? reason));
