"use strict";

const http = require("http");
const { buildAgent } = require("./index.js");

const PORT = parseInt(process.env.PORT || "3000", 10);
const AUTH_TOKEN = process.env.API_AUTH_TOKEN || null;

function send(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    const MAX_BYTES = 1024 * 1024;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function isAuthorized(req) {
  if (!AUTH_TOKEN) return true;
  const header = req.headers["authorization"] || "";
  return header === `Bearer ${AUTH_TOKEN}`;
}

async function main() {
  const agent = buildAgent();

  if (!AUTH_TOKEN) {
    console.warn(
      "[server] WARNING: API_AUTH_TOKEN is not set. All endpoints are open " +
        "to anyone who can reach this service. Set API_AUTH_TOKEN before " +
        "exposing this publicly."
    );
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

      if (url.pathname === "/health") {
        return send(res, 200, { ok: true });
      }

      if (!isAuthorized(req)) {
        return send(res, 401, { error: "unauthorized" });
      }

      if (req.method === "GET" && url.pathname === "/status") {
        return send(res, 200, { connectors: agent.connectors.list() });
      }

      if (req.method === "GET" && url.pathname === "/dashboard") {
        return send(res, 200, agent.dashboard());
      }

      if (req.method === "POST" && url.pathname === "/task") {
        const raw = await readBody(req);
        let task;
        try {
          task = raw ? JSON.parse(raw) : {};
        } catch (e) {
          return send(res, 400, { error: "invalid JSON body" });
        }
        if (!task.type) {
          return send(res, 400, { error: "task.type is required" });
        }
        task.id = task.id || `task-${Date.now()}`;
        const result = await agent.processTask(task);
        return send(res, 200, result);
      }

      return send(res, 404, { error: "not found" });
    } catch (err) {
      console.error("[server] request error:", err);
      return send(res, 500, { error: "internal error" });
    }
  });

  server.listen(PORT, () => {
    console.log(`[server] Universal Digital Agent listening on :${PORT}`);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
