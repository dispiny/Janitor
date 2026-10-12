import dgram from "node:dgram";

const MAC_RE = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;

export function parseMac(mac: string): Buffer {
  if (!MAC_RE.test(mac)) {
    throw new Error("invalid MAC address");
  }
  return Buffer.from(mac.split(":").map((part) => Number.parseInt(part, 16)));
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
};

export async function sendMagicPacket(input: {
  mac: string;
  broadcast: string;
  port: number;
}): Promise<MagicPacketResult> {
  const packet = buildMagicPacket(input.mac);
  const socket = dgram.createSocket("udp4");

  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(() => {
      try {
        socket.setBroadcast(true);
        socket.send(packet, input.port, input.broadcast, (error) => {
          socket.close();
          if (error) reject(error);
          else resolve();
        });
      } catch (error) {
        socket.close();
        reject(error);
      }
    });
  });

  return {
    ok: true,
    mode: "manual",
    mac: input.mac.toUpperCase(),
    broadcast: input.broadcast,
    port: input.port,
    bytes: packet.length,
  };
}
