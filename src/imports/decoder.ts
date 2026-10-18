import { Transform, type TransformCallback } from "node:stream";

export type InputEncoding = "utf8" | "utf16le" | "windows-1252";

export class DecodeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DecodeError";
  }
}

export class EncodingTransform extends Transform {
  private readonly requested: InputEncoding;
  private prefix = Buffer.alloc(0);
  private decoder: TextDecoder | null = null;

  public constructor(requested: InputEncoding) {
    super({ readableObjectMode: false, writableObjectMode: false });
    this.requested = requested;
  }

  public override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      if (!this.decoder) {
        this.prefix = Buffer.concat([this.prefix, chunk]);
        if (this.prefix.length < 3) return callback();
        const hasUtf8Bom = this.prefix.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
        const hasUtf16Bom = this.prefix.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]));
        if (this.requested === "utf16le" && !hasUtf16Bom) throw new DecodeError("UTF-16LE input must include a BOM");
        if (this.requested === "utf8") {
          this.decoder = new TextDecoder("utf-8", { fatal: true });
          this.prefix = hasUtf8Bom ? this.prefix.subarray(3) : this.prefix;
        } else if (this.requested === "utf16le") {
          this.decoder = new TextDecoder("utf-16le", { fatal: true });
          this.prefix = this.prefix.subarray(2);
        } else {
          this.decoder = new TextDecoder("windows-1252");
        }
        const output = this.decoder.decode(this.prefix, { stream: true });
        this.prefix = Buffer.alloc(0);
        if (output) this.push(output);
        return callback();
      }
      const output = this.decoder.decode(chunk, { stream: true });
      if (output) this.push(output);
      callback();
    } catch (error: unknown) {
      callback(error instanceof Error ? error : new DecodeError("Input decoding failed"));
    }
  }

  public override _flush(callback: TransformCallback): void {
    try {
      if (!this.decoder) {
        if (this.requested === "utf16le" && !this.prefix.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) {
          throw new DecodeError("UTF-16LE input must include a BOM");
        }
        this.decoder = new TextDecoder(this.requested === "utf16le" ? "utf-16le" : this.requested === "utf8" ? "utf-8" : "windows-1252", { fatal: this.requested !== "windows-1252" });
        const skip = this.requested === "utf16le" ? 2 : this.prefix.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? 3 : 0;
        const output = this.decoder.decode(this.prefix.subarray(skip));
        if (output) this.push(output);
      } else {
        const output = this.decoder.decode();
        if (output) this.push(output);
      }
      callback();
    } catch (error: unknown) {
      callback(error instanceof Error ? error : new DecodeError("Input decoding failed"));
    }
  }
}
