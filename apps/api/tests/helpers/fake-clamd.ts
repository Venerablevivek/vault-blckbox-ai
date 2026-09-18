import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';

/** The standard anti-virus test string: harmless, and detected by every scanner. */
export const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/**
 * A stand-in for clamd that speaks the real INSTREAM protocol: it parses the length-prefixed
 * chunks exactly as clamd does and reports EICAR as found. `down` makes it drop connections, like
 * a scanner that is unavailable.
 */
export async function startFakeClamd() {
  let down = false;
  const received: number[] = [];
  const server: Server = createServer((socket: Socket) => {
    if (down) {
      socket.destroy();
      return;
    }
    let buffer = Buffer.alloc(0);
    let commandSeen = false;
    const body: Buffer[] = [];
    socket.on('data', (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      if (!commandSeen) {
        const end = buffer.indexOf(0);
        if (end < 0) return;
        if (buffer.subarray(0, end).toString() !== 'zINSTREAM') {
          socket.end('UNKNOWN COMMAND\0');
          return;
        }
        commandSeen = true;
        buffer = buffer.subarray(end + 1);
      }
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (length === 0) {
          const content = Buffer.concat(body);
          received.push(content.length);
          socket.end(content.includes(EICAR) ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
          return;
        }
        if (buffer.length < 4 + length) return;
        body.push(buffer.subarray(4, 4 + length));
        buffer = buffer.subarray(4 + length);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    received,
    setDown(value: boolean) {
      down = value;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
