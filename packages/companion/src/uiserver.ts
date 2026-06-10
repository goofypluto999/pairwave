/**
 * Localhost UI server.  (SPEC §3.3)
 *
 * Serves the dashboard (a single dependency-free static page — nothing to build, nothing to break)
 * and a small JSON API, bound to 127.0.0.1 ONLY: decrypted content never leaves the machine. Live
 * updates via SSE. If the preferred port is taken it walks forward up to 20 ports.
 */
import http from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { topoOrder } from "@pairwave/protocol";
import type { CompanionRuntime } from "./runtime.js";

const HERE = dirname(fileURLToPath(import.meta.url));

export type UiHandle = { url: string; port: number; close(): Promise<void> };

function json(res: http.ServerResponse, code: number, value: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return {};
  }
}

export async function startUiServer(rt: CompanionRuntime, preferredPort = 7591): Promise<UiHandle> {
  // The page ships inside the package (../ui/index.html relative to dist/). Read at startup as a
  // guaranteed-good fallback, but serve fresh from disk per request so UI updates land on refresh.
  const pagePath = join(HERE, "..", "ui", "index.html");
  const pageFallback = readFileSync(pagePath, "utf8");
  const freshPage = (): string => {
    try {
      return readFileSync(pagePath, "utf8");
    } catch {
      return pageFallback;
    }
  };
  const sseClients = new Set<http.ServerResponse>();

  const unsubscribe = rt.onChange(() => {
    for (const res of [...sseClients]) {
      try {
        res.write(`data: {"type":"changed"}\n\n`);
      } catch {
        sseClients.delete(res);
      }
    }
  });

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/index.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(freshPage());
      }
      if (req.method === "GET" && u.pathname === "/api/state") {
        return json(res, 200, { ...(await rt.status()), chainOk: rt.chainVerified() });
      }
      if (req.method === "GET" && u.pathname === "/api/messages") {
        const limit = Math.min(Number(u.searchParams.get("limit") ?? "200") || 200, 1000);
        const msgs = topoOrder(rt.core.messages())
          .slice(-limit)
          .map((m) => ({
            msgId: m.msgId,
            ts: m.ts,
            from: m.sender.name,
            peerId: m.sender.peerId,
            origin: m.origin,
            kind: m.kind,
            body: m.body,
          }));
        return json(res, 200, msgs);
      }
      if (req.method === "GET" && u.pathname === "/api/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(`data: {"type":"hello"}\n\n`);
        sseClients.add(res);
        const keepalive = setInterval(() => {
          try {
            res.write(`: keepalive\n\n`);
          } catch {
            clearInterval(keepalive);
          }
        }, 25_000);
        keepalive.unref();
        req.on("close", () => {
          clearInterval(keepalive);
          sseClients.delete(res);
        });
        return;
      }

      const perm = u.pathname.match(/^\/api\/permissions\/([^/]+)$/);
      if (req.method === "POST" && perm) {
        const body = await readBody(req);
        const result = rt.decidePermission(
          decodeURIComponent(perm[1] ?? ""),
          body.decision === "approve" ? "approve" : "deny",
          { alwaysAllowKind: body.always === true },
        );
        return json(res, result.ok ? 200 : 400, result);
      }
      if (req.method === "POST" && u.pathname === "/api/verify") {
        rt.confirmVerification();
        return json(res, 200, { verified: true });
      }
      if (req.method === "POST" && u.pathname === "/api/floor") {
        const body = await readBody(req);
        const op = String(body.op);
        const result =
          op === "claim"
            ? await rt.send("turn.claim", {}, "human")
            : await rt.send("turn.yield", { to: String(body.to ?? "none") }, "human");
        return json(res, result.ok ? 200 : 400, result);
      }
      if (req.method === "POST" && u.pathname === "/api/send") {
        const body = await readBody(req);
        const text = String(body.text ?? "").trim();
        if (!text) return json(res, 400, { error: "empty message" });
        const result = await rt.send("chat", { text }, "human");
        return json(res, result.ok ? 200 : 400, result);
      }
      if (req.method === "POST" && u.pathname === "/api/handoff") {
        return json(res, 200, { path: rt.writeHandoffNow() });
      }
      return json(res, 404, { error: "not_found" });
    } catch (e) {
      return json(res, 500, { error: (e as Error).message });
    }
  });

  // Bind localhost only; walk forward if the port is taken.
  let port = preferredPort;
  for (let attempt = 0; ; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.removeAllListeners("error");
          resolve();
        });
      });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EADDRINUSE" && attempt < 20) {
        port += 1;
        continue;
      }
      throw e;
    }
  }

  const url = `http://127.0.0.1:${port}`;
  rt.uiUrl = url;
  return {
    url,
    port,
    close: async () => {
      unsubscribe();
      for (const res of sseClients) {
        try {
          res.end();
        } catch {
          /* closing */
        }
      }
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
