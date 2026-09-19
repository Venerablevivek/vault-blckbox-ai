import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { withReference } from './reference';

/** Regenerates the API reference section of docs/04-api-spec.md. */
const target = path.resolve(__dirname, '../../../../docs/04-api-spec.md');
writeFileSync(target, withReference(readFileSync(target, 'utf8')));
process.stdout.write(`wrote ${target}\n`);
