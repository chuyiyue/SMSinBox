export interface LineSocket {
  readLine(): Promise<string>;
  write(data: string): Promise<void>;
  close(): Promise<void>;
}

export interface SmtpMessage {
  username: string;
  password: string;
  from: string;
  to: string;
  subject: string;
  text: string;
}

export async function sendSmtp(socket: LineSocket, message: SmtpMessage): Promise<void> {
  await expectReply(socket, [220]);
  await command(socket, "EHLO smsinbox", [250]);
  await command(socket, "AUTH LOGIN", [334]);
  await command(socket, base64(message.username), [334]);
  await command(socket, base64(message.password), [235]);
  await command(socket, `MAIL FROM:<${message.from}>`, [250]);
  await command(socket, `RCPT TO:<${message.to}>`, [250]);
  await command(socket, "DATA", [354]);
  await socket.write(`${dotStuff(renderData(message))}\r\n.\r\n`);
  await expectReply(socket, [250]);
  await command(socket, "QUIT", [221]);
  await socket.close();
}

export function createLineSocket(
  readable: ReadableStream<Uint8Array>,
  writable: WritableStream<Uint8Array>,
): LineSocket {
  const reader = readable.getReader();
  const writer = writable.getWriter();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async readLine() {
      while (!buffer.includes("\n")) {
        const { done, value } = await reader.read();
        if (done) throw new Error("SMTP 连接已关闭");
        if (value) buffer += decoder.decode(value, { stream: true });
      }
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      return line;
    },
    async write(data: string) {
      await writer.write(new TextEncoder().encode(data));
    },
    async close() {
      await writer.close().catch(() => undefined);
      await reader.cancel().catch(() => undefined);
    },
  };
}

export async function openSmtpSocket(host: string, port: number): Promise<LineSocket> {
  const { connect } = await import("cloudflare:sockets");
  const socket = connect(
    { hostname: host, port },
    { secureTransport: "on", allowHalfOpen: false },
  );
  return createLineSocket(socket.readable, socket.writable);
}

export function renderData(message: SmtpMessage): string {
  const subject = `=?UTF-8?B?${base64(message.subject)}?=`;
  return [
    `From: ${message.from}`,
    `To: ${message.to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    message.text.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n"),
  ].join("\r\n");
}

export function dotStuff(body: string): string {
  const normalized = body.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, "\r\n");
  return normalized
    .split("\r\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
}

async function command(socket: LineSocket, line: string, expected: number[]): Promise<void> {
  await socket.write(`${line}\r\n`);
  await expectReply(socket, expected);
}

async function expectReply(socket: LineSocket, expected: number[]): Promise<void> {
  const reply = await readReply(socket);
  if (!expected.includes(reply.code)) {
    throw new Error(`SMTP 返回 ${reply.code}`);
  }
}

async function readReply(socket: LineSocket): Promise<{ code: number }> {
  let line = await socket.readLine();
  const code = smtpCode(line);
  while (line.length >= 4 && line[3] === "-") {
    line = await socket.readLine();
    if (smtpCode(line) !== code) throw new Error("SMTP 响应无效");
  }
  return { code };
}

function smtpCode(line: string): number {
  if (!/^\d{3}([ -]|$)/.test(line)) throw new Error("SMTP 响应无效");
  return Number(line.slice(0, 3));
}

function base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
