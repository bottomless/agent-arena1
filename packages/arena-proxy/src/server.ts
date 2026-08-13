import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { ArenaProxyService } from "./service.js";
import type { ArenaSide } from "./types.js";
import {
  blindCompletionPayload,
  blindIdentityText,
  BlindedSseTransform,
} from "./blind-response.js";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? (JSON.parse(body) as Record<string, unknown>) : {};
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function routeParts(url: string | undefined): string[] {
  return new URL(url ?? "/", "http://arena.local").pathname.split("/").filter(Boolean);
}

function upstreamHeaders(upstream: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of ["content-type", "cache-control", "x-request-id"]) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }
  return headers;
}

async function sendBlindedUpstream(
  response: ServerResponse,
  upstream: Response,
  opaqueModel: string,
  hiddenModel: string,
): Promise<void> {
  response.writeHead(upstream.status, upstreamHeaders(upstream));
  if (!upstream.body) {
    response.end();
    return;
  }
  if (upstream.headers.get("content-type")?.includes("text/event-stream")) {
    await pipeline(
      Readable.from(upstream.body as unknown as AsyncIterable<Uint8Array>),
      new BlindedSseTransform(opaqueModel, [hiddenModel]),
      response,
    );
    return;
  }
  const raw = await upstream.text();
  try {
    response.end(
      JSON.stringify(blindCompletionPayload(JSON.parse(raw), opaqueModel, [hiddenModel])),
    );
  } catch {
    response.end(blindIdentityText(raw, opaqueModel, [hiddenModel]));
  }
}

async function handleInference(
  service: ArenaProxyService,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readJson(request);
  const opaqueModel = String(body.model ?? "arena");
  if (!service.isInferenceAuthorized(request.headers.authorization, opaqueModel)) {
    sendJson(response, 401, { error: "Unauthorized" });
    return;
  }
  const abortController = new AbortController();
  request.once("aborted", () => abortController.abort());
  response.once("close", () => {
    if (!response.writableEnded) abortController.abort();
  });
  const hiddenModel = await service.resolveRequestedModel(opaqueModel);
  const upstream = await service.forwardChatCompletion(body, abortController.signal);
  await sendBlindedUpstream(response, upstream, opaqueModel, hiddenModel);
}

async function handleBattleAction(
  service: ArenaProxyService,
  request: IncomingMessage,
  response: ServerResponse,
  battleId: string,
  action: string | undefined,
): Promise<boolean> {
  if (request.method === "GET" && !action) {
    sendJson(response, 200, await service.getBattle(battleId));
    return true;
  }
  if (request.method !== "POST") return false;
  if (action === "complete") {
    const body = await readJson(request);
    if (body.side !== "A" && body.side !== "B") throw new Error("Invalid side");
    sendJson(response, 200, await service.markComplete(battleId, body.side as ArenaSide));
    return true;
  }
  if (action === "vote") {
    const body = await readJson(request);
    if (body.vote !== "A" && body.vote !== "B" && body.vote !== "tie") {
      throw new Error("Invalid vote");
    }
    sendJson(response, 200, await service.vote(battleId, body.vote));
    return true;
  }
  if (action === "stop") {
    sendJson(response, 200, await service.stop(battleId));
    return true;
  }
  if (action === "comparison") {
    const body = await readJson(request);
    const comparison = await service.startComparison(
      battleId,
      String(body.prompt ?? ""),
      String(body.diff ?? ""),
      Number(body.changedFiles),
      body.hasEdits === true,
    );
    sendJson(response, 202, comparison);
    return true;
  }
  return false;
}

async function handleControlRequest(
  service: ArenaProxyService,
  request: IncomingMessage,
  response: ServerResponse,
  parts: string[],
): Promise<void> {
  if (!service.isAuthorized(request.headers.authorization)) {
    sendJson(response, 401, { error: "Unauthorized" });
    return;
  }
  if (request.method === "POST" && parts.join("/") === "api/battles") {
    const body = await readJson(request);
    const battle = await service.createBattle(String(body.userId ?? ""), String(body.prompt ?? ""));
    sendJson(response, 201, battle);
    return;
  }
  const battleId = parts[0] === "api" && parts[1] === "battles" ? parts[2] : undefined;
  if (battleId && (await handleBattleAction(service, request, response, battleId, parts[3])))
    return;
  sendJson(response, 404, { error: "Not found" });
}

async function handleRequest(
  service: ArenaProxyService,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const parts = routeParts(request.url);
  const route = parts.join("/");
  if (request.method === "GET" && route === "health") {
    sendJson(response, 200, { ok: true });
    return;
  }
  if (request.method === "POST" && route === "v1/chat/completions") {
    await handleInference(service, request, response);
    return;
  }
  await handleControlRequest(service, request, response, parts);
}

function handleRequestError(response: ServerResponse, error: unknown): void {
  const resolvedError = error instanceof Error ? error : new Error(String(error));
  if (response.headersSent) {
    if (!response.destroyed) response.destroy(resolvedError);
    return;
  }
  try {
    sendJson(response, /not found/i.test(resolvedError.message) ? 404 : 400, {
      error: resolvedError.message,
    });
  } catch {
    if (!response.destroyed) response.destroy(resolvedError);
  }
}

export function createArenaProxyServer(service: ArenaProxyService) {
  return createServer((request, response) => {
    void handleRequest(service, request, response).catch((error: unknown) => {
      handleRequestError(response, error);
    });
  });
}
