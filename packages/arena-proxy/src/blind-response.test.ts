import { describe, expect, it } from "vitest";

import {
  blindCompletionPayload,
  blindIdentityText,
  BlindedSseTransform,
} from "./blind-response.js";

describe("blinded completion responses", () => {
  it("replaces model identity and removes provider metadata", () => {
    expect(
      blindCompletionPayload(
        {
          id: "generation-id",
          model: "secret/model",
          provider: "Secret Provider",
          choices: [{ message: { role: "assistant", content: "done" } }],
        },
        "arena_token",
      ),
    ).toEqual({
      id: "generation-id",
      model: "arena_token",
      choices: [{ message: { role: "assistant", content: "done" } }],
    });
  });

  it("redacts model IDs embedded in error strings", () => {
    expect(
      blindCompletionPayload(
        { error: { message: "No endpoint is available for secret/model" } },
        "arena_token",
        ["secret/model"],
      ),
    ).toEqual({ error: { message: "No endpoint is available for arena_token" } });
    expect(blindIdentityText("Model secret/model failed", "arena_token", ["secret/model"])).toBe(
      "Model arena_token failed",
    );
  });

  it("blinds SSE metadata across arbitrary chunk boundaries", async () => {
    const transform = new BlindedSseTransform("arena_token");
    const output: Buffer[] = [];
    transform.on("data", (chunk: Buffer) => output.push(chunk));
    transform.write('data: {"id":"one","model":"sec');
    transform.write('ret/model","choices":[]}\n\ndata: [DONE]\n\n');
    transform.end();
    await new Promise<void>((resolve, reject) => {
      transform.on("end", resolve);
      transform.on("error", reject);
    });
    expect(Buffer.concat(output).toString("utf8")).toBe(
      'data: {"id":"one","model":"arena_token","choices":[]}\n\ndata: [DONE]\n\n',
    );
  });
});
