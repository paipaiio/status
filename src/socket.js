"use strict";

const crypto = require("node:crypto");

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

class WebSocketHub {
  constructor(options = {}) {
    this.clients = new Set();
    this.getSnapshot = options.getSnapshot || (() => ({}));
    this.pingTimer = setInterval(() => this.pingClients(), 30000);
    this.pingTimer.unref?.();
  }

  handleUpgrade(req, socket) {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname !== "/socket") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    const key = req.headers["sec-websocket-key"];
    const upgrade = String(req.headers.upgrade || "").toLowerCase();
    if (!key || upgrade !== "websocket") {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    const handshake =
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${createWebSocketAccept(key)}`,
        "\r\n"
      ].join("\r\n");

    socket.setNoDelay(true);
    this.clients.add(socket);
    socket.on("data", (chunk) => handleIncomingFrame(socket, chunk));
    socket.on("close", () => this.clients.delete(socket));
    socket.on("end", () => this.clients.delete(socket));
    socket.on("error", () => this.clients.delete(socket));

    socket.write(handshake, () => {
      setImmediate(() => {
        this.send(socket, {
          type: "status",
          event: "connected",
          ...this.getSnapshot()
        });
      });
    });
  }

  broadcastSnapshot(event = "update", targetId = null) {
    this.broadcast({
      type: "status",
      event,
      targetId,
      ...this.getSnapshot()
    });
  }

  broadcast(payload) {
    const message = JSON.stringify(payload);
    for (const socket of this.clients) {
      this.sendRaw(socket, message);
    }
  }

  send(socket, payload) {
    this.sendRaw(socket, JSON.stringify(payload));
  }

  sendRaw(socket, message) {
    if (socket.destroyed || socket.writableEnded) {
      this.clients.delete(socket);
      return;
    }

    socket.write(encodeTextFrame(message), (error) => {
      if (error) this.clients.delete(socket);
    });
  }

  pingClients() {
    for (const socket of this.clients) {
      if (socket.destroyed || socket.writableEnded) {
        this.clients.delete(socket);
        continue;
      }
      socket.write(encodeFrame(Buffer.alloc(0), 0x9));
    }
  }

  close() {
    clearInterval(this.pingTimer);
    for (const socket of this.clients) {
      socket.end(encodeFrame(Buffer.alloc(0), 0x8));
    }
    this.clients.clear();
  }
}

function createWebSocketAccept(key) {
  return crypto.createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
}

function encodeTextFrame(message) {
  return encodeFrame(Buffer.from(message), 0x1);
}

function encodeFrame(payload, opcode) {
  const length = payload.length;
  let header;

  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length <= 65535) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

function handleIncomingFrame(socket, chunk) {
  let offset = 0;
  while (offset + 2 <= chunk.length) {
    const firstByte = chunk[offset++];
    const secondByte = chunk[offset++];
    const opcode = firstByte & 0x0f;
    const masked = Boolean(secondByte & 0x80);
    let length = secondByte & 0x7f;

    if (length === 126) {
      if (offset + 2 > chunk.length) return;
      length = chunk.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (offset + 8 > chunk.length) return;
      length = Number(chunk.readBigUInt64BE(offset));
      offset += 8;
    }

    let mask;
    if (masked) {
      if (offset + 4 > chunk.length) return;
      mask = chunk.subarray(offset, offset + 4);
      offset += 4;
    }

    if (offset + length > chunk.length) return;
    const payload = chunk.subarray(offset, offset + length);
    offset += length;

    if (opcode === 0x8) {
      socket.end(encodeFrame(Buffer.alloc(0), 0x8));
      return;
    }

    if (opcode === 0x9) {
      socket.write(encodeFrame(payload, 0xA));
      continue;
    }

    if (masked) {
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }
    }
  }
}

module.exports = {
  WebSocketHub,
  createWebSocketAccept,
  encodeTextFrame
};
