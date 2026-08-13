import { Transform, type TransformCallback } from "node:stream";
import { StringDecoder } from "node:string_decoder";

const IDENTITY_KEYS = new Set(["provider", "provider_name", "model_name", "model_id"]);

export function blindIdentityText(
  value: string,
  opaqueModel: string,
  hiddenIdentities: readonly string[],
) {
  let redacted = value;
  const variants = new Set(
    hiddenIdentities.flatMap((identity) => [identity, identity.replace(/^~/, "")]),
  );
  for (const identity of [...variants]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)) {
    redacted = redacted.replaceAll(identity, opaqueModel);
  }
  return redacted;
}

export function blindCompletionPayload(
  value: unknown,
  opaqueModel: string,
  hiddenIdentities: readonly string[] = [],
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => blindCompletionPayload(entry, opaqueModel, hiddenIdentities));
  }
  if (typeof value === "string") return blindIdentityText(value, opaqueModel, hiddenIdentities);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "model") {
      output[key] = opaqueModel;
    } else if (!IDENTITY_KEYS.has(key)) {
      output[key] = blindCompletionPayload(entry, opaqueModel, hiddenIdentities);
    }
  }
  return output;
}

export function blindSseLine(
  line: string,
  opaqueModel: string,
  hiddenIdentities: readonly string[] = [],
): string {
  const match = /^(\s*data:\s*)(.*)$/.exec(line);
  if (!match || match[2] === "[DONE]") return line;
  try {
    return `${match[1]}${JSON.stringify(
      blindCompletionPayload(JSON.parse(match[2] ?? ""), opaqueModel, hiddenIdentities),
    )}`;
  } catch {
    return blindIdentityText(line, opaqueModel, hiddenIdentities);
  }
}

export class BlindedSseTransform extends Transform {
  private readonly decoder = new StringDecoder("utf8");
  private buffered = "";

  constructor(
    private readonly opaqueModel: string,
    private readonly hiddenIdentities: readonly string[] = [],
  ) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.buffered += this.decoder.write(chunk);
    this.flushCompleteLines();
    callback();
  }

  override _flush(callback: TransformCallback): void {
    this.buffered += this.decoder.end();
    if (this.buffered) {
      this.push(blindSseLine(this.buffered, this.opaqueModel, this.hiddenIdentities));
    }
    this.buffered = "";
    callback();
  }

  private flushCompleteLines(): void {
    let newline = this.buffered.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffered.slice(0, newline);
      this.buffered = this.buffered.slice(newline + 1);
      const carriageReturn = line.endsWith("\r") ? "\r" : "";
      const content = carriageReturn ? line.slice(0, -1) : line;
      this.push(
        `${blindSseLine(content, this.opaqueModel, this.hiddenIdentities)}${carriageReturn}\n`,
      );
      newline = this.buffered.indexOf("\n");
    }
  }
}
