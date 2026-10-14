import dgram from "node:dgram";

/** Limited broadcast reaches the whole local segment without knowing the subnet. */
export const DEFAULT_BROADCAST = "255.255.255.255";
export const DEFAULT_WOL_PORT = 9;
const SEND_REPEATS = 3;
const SEND_GAP_MS = 100;

/** Accepts AA:BB:CC:DD:EE:FF, AA-BB-CC-DD-EE-FF (Windows ipconfig) or AABBCCDDEEFF. */
export function normalizeMac(mac: string): string {
  const hex = (mac || "").trim().replace(/[:\-.\s]/g, "");
  if (!/^[0-9A-Fa-f]{12}$/.test(hex)) {
    throw new Error("invalid MAC address");
  }
  return hex.toUpperCase().match(/../g)!.join(":");
}

export function parseMac(mac: string): Buffer {
  return Buffer.from(normalizeMac(mac).split(":").map((part) => Number.parseInt(part, 16)));
}

export function buildMagicPacket(mac: string): Buffer {
  const address = parseMac(mac);
  const packet = Buffer.alloc(6 + 16 * 6);
  packet.fill(0xff, 0, 6);
  for (let i = 0; i < 16; i += 1) {
    address.copy(packet, 6 + i * 6);
  }
  return packet;
}

export type MagicPacketResult = {
  ok: true;
  mode: "manual";
  mac: string;
  broadcast: string;
  port: number;
  bytes: number;
  sent: number;
};

export async function sendMagicPacket(input: {
  mac: string;
  broadcast?: string | null;
  port?: number | null;
}): Promise<MagicPacketResult> {
  const mac = normalizeMac(input.mac);
  const broadcast = input.broadcast?.trim() || DEFAULT_BROADCAST;
  const port = input.port || DEFAULT_WOL_PORT;
  const packet = buildMagicPacket(mac);
  const socket = dgram.createSocket("udp4");

  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(() => {
        socket.setBroadcast(true);
        resolve();
      });
    });
    // Repeat because UDP is fire-and-forget and some NICs miss the first frame.
    for (let i = 0; i < SEND_REPEATS; i += 1) {
      await new Promise<void>((resolve, reject) => {
        socket.send(packet, port, broadcast, (error) => (error ? reject(error) : resolve()));
      });
      if (i < SEND_REPEATS - 1) await new Promise((r) => setTimeout(r, SEND_GAP_MS));
    }
  } finally {
    socket.close();
  }

  return { ok: true, mode: "manual", mac, broadcast, port, bytes: packet.length, sent: SEND_REPEATS };
}
