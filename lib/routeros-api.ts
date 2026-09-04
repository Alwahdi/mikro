import net from "net";
import tls from "tls";

type Config = {
  host: string;
  port: number;
  username: string;
  password: string;
  tls?: boolean;
  rejectUnauthorized?: boolean;
  timeoutMs?: number;
};

type Row = Record<string, string>;
type Waiter = {
  resolve: (sentence: string[]) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

function encodeLength(length: number) {
  if (length < 0x80) return Buffer.from([length]);
  if (length < 0x4000) {
    length |= 0x8000;
    return Buffer.from([(length >> 8) & 0xff, length & 0xff]);
  }
  if (length < 0x200000) {
    length |= 0xc00000;
    return Buffer.from([(length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff]);
  }
  if (length < 0x10000000) {
    length |= 0xe0000000;
    return Buffer.from([(length >> 24) & 0xff, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff]);
  }
  return Buffer.from([0xf0, (length >> 24) & 0xff, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff]);
}

function encodeWord(value: string) {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([encodeLength(bytes.length), bytes]);
}

function encodeSentence(words: string[]) {
  return Buffer.concat([...words.map(encodeWord), Buffer.from([0])]);
}

function readLength(buffer: Buffer, offset: number): [number, number] | null {
  if (offset >= buffer.length) return null;
  let c = buffer[offset++];
  if ((c & 0x80) === 0) return [c, offset];
  if ((c & 0xc0) === 0x80) {
    if (offset >= buffer.length) return null;
    return [((c & ~0xc0) << 8) + buffer[offset++], offset];
  }
  if ((c & 0xe0) === 0xc0) {
    if (offset + 1 >= buffer.length) return null;
    return [((c & ~0xe0) << 16) + (buffer[offset++] << 8) + buffer[offset++], offset];
  }
  if ((c & 0xf0) === 0xe0) {
    if (offset + 2 >= buffer.length) return null;
    return [((c & ~0xf0) << 24) + (buffer[offset++] << 16) + (buffer[offset++] << 8) + buffer[offset++], offset];
  }
  if ((c & 0xf8) === 0xf0) {
    if (offset + 3 >= buffer.length) return null;
    return [(buffer[offset++] << 24) + (buffer[offset++] << 16) + (buffer[offset++] << 8) + buffer[offset++], offset];
  }
  throw new Error("Unsupported RouterOS API length");
}

export class RouterOSClient {
  private socket: net.Socket | tls.TLSSocket | null = null;
  private buffer = Buffer.alloc(0);
  private queue: string[][] = [];
  private waiters: Waiter[] = [];

  constructor(private readonly config: Config) {}

  private fail(error: Error) {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  private parse() {
    while (true) {
      let offset = 0;
      const words: string[] = [];
      while (true) {
        const result = readLength(this.buffer, offset);
        if (!result) return;
        const [length, nextOffset] = result;
        offset = nextOffset;
        if (length === 0) break;
        if (offset + length > this.buffer.length) return;
        words.push(this.buffer.subarray(offset, offset + length).toString("utf8"));
        offset += length;
      }
      this.buffer = this.buffer.subarray(offset);
      const waiter = this.waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(words);
      } else {
        this.queue.push(words);
      }
    }
  }

  private nextSentence() {
    if (this.queue.length) return Promise.resolve(this.queue.shift()!);
    return new Promise<string[]>((resolve, reject) => {
      const timeout = this.config.timeoutMs ?? 10000;
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((item) => item.resolve === resolve);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("RouterOS API response timeout"));
      }, timeout);
      this.waiters.push({ resolve, reject, timer });
    });
  }

  private write(words: string[]) {
    if (!this.socket) throw new Error("Router is not connected");
    this.socket.write(encodeSentence(words));
  }

  private async connect() {
    if (this.socket) return;

    if (this.config.tls) {
      const socket = tls.connect({
        host: this.config.host,
        port: this.config.port,
        rejectUnauthorized: this.config.rejectUnauthorized ?? false,
      });
      this.socket = socket;
      await new Promise<void>((resolve, reject) => {
        socket.once("secureConnect", resolve);
        socket.once("error", reject);
      });
    } else {
      const socket = net.connect({ host: this.config.host, port: this.config.port });
      this.socket = socket;
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
    }

    this.socket.on("data", (data) => {
      this.buffer = Buffer.concat([this.buffer, data]);
      this.parse();
    });
    this.socket.on("error", (error) => this.fail(error));
    this.socket.setTimeout(this.config.timeoutMs ?? 10000, () => {
      this.fail(new Error("Router connection timeout"));
      this.socket?.destroy();
    });

    await this.login();
  }

  private async login() {
    // Modern RouterOS accepts credentials in the first /login sentence. Older
    // releases return a =ret= challenge (usually in !done) and require the
    // legacy MD5 challenge-response exchange.
    this.write(["/login", `=name=${this.config.username}`, `=password=${this.config.password}`]);
    const first = await this.nextSentence();

    if (first[0] === "!trap" || first[0] === "!fatal") {
      throw new Error(first.find((word) => word.startsWith("=message="))?.slice(9) || "Authentication failed");
    }

    const challenge = first.find((word) => word.startsWith("=ret="))?.slice(5);
    if (challenge) {
      const { createHash } = await import("crypto");
      const response = createHash("md5")
        .update(Buffer.concat([Buffer.from([0]), Buffer.from(this.config.password), Buffer.from(challenge, "hex")]))
        .digest("hex");

      this.write(["/login", `=name=${this.config.username}`, `=response=00${response}`]);
      const second = await this.nextSentence();
      if (second[0] === "!trap" || second[0] === "!fatal") {
        throw new Error(second.find((word) => word.startsWith("=message="))?.slice(9) || "Authentication failed");
      }
      if (second[0] !== "!done") throw new Error("Authentication failed");
      return;
    }

    if (first[0] === "!done") return;
    throw new Error("Authentication failed");
  }

  async command(path: string, args: string[] = []): Promise<Row[]> {
    await this.connect();
    this.write([path, ...args]);
    const rows: Row[] = [];

    while (true) {
      const sentence = await this.nextSentence();
      const type = sentence[0];
      if (type === "!re") {
        const row: Row = {};
        for (const word of sentence.slice(1)) {
          if (!word.startsWith("=")) continue;
          const separator = word.indexOf("=", 1);
          if (separator > 1) row[word.slice(1, separator)] = word.slice(separator + 1);
        }
        rows.push(row);
        continue;
      }
      if (type === "!trap" || type === "!fatal") {
        throw new Error(sentence.find((word) => word.startsWith("=message="))?.slice(9) || "RouterOS API error");
      }
      if (type === "!done") return rows;
    }
  }

  close() {
    this.socket?.destroy();
    this.socket = null;
  }
}
