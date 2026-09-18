import { connect } from 'node:net';
import type { Readable } from 'node:stream';

export type ScanResult = { infected: false } | { infected: true; signature: string };

/** Scans a stream of file bytes. Throws if the scanner is unavailable or can't give an answer. */
export interface Scanner {
  scan(stream: Readable): Promise<ScanResult>;
}

/**
 * ClamAV's clamd over TCP, using the INSTREAM command: the file is sent in length-prefixed chunks,
 * so it never has to exist on the scanner's disk and memory stays flat on our side.
 *
 * Protocol: "zINSTREAM\0", then for each chunk a 4-byte big-endian length and the bytes, then a
 * zero length. The reply is "stream: OK", "stream: <signature> FOUND" or "... ERROR".
 */
export class ClamdScanner implements Scanner {
  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly timeoutMs: number,
  ) {}

  scan(stream: Readable): Promise<ScanResult> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: this.host, port: this.port });
      let reply = '';
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        stream.destroy();
        reject(error);
      };

      socket.setTimeout(this.timeoutMs, () => fail(new Error('clamd timed out')));
      socket.on('error', fail);
      socket.on('data', (data: Buffer) => {
        reply += data.toString('utf8');
      });
      socket.on('end', () => {
        if (settled) return;
        settled = true;
        const text = reply.replace(/\0/g, '').trim();
        const found = /^stream: (.+) FOUND$/.exec(text);
        if (found) resolve({ infected: true, signature: found[1]! });
        else if (text === 'stream: OK') resolve({ infected: false });
        else reject(new Error(`clamd could not scan the file: ${text || 'no reply'}`));
      });

      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        stream.on('data', (chunk: Buffer) => {
          const header = Buffer.alloc(4);
          header.writeUInt32BE(chunk.length, 0);
          // Respect backpressure so a large file never piles up in memory.
          if (!socket.write(Buffer.concat([header, chunk]))) {
            stream.pause();
            socket.once('drain', () => stream.resume());
          }
        });
        stream.on('end', () => socket.write(Buffer.alloc(4)));
        stream.on('error', (error: Error) => fail(error));
      });
    });
  }
}
