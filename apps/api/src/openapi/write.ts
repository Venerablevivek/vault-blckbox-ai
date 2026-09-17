import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildOpenApiDocument } from './document';

/**
 * Writes openapi.json at the package root. Committed, so API changes show up in review, and CI
 * fails if it is out of date (the web client's types are generated from it).
 */
const target = path.resolve(__dirname, '../../openapi.json');
writeFileSync(target, `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`);
process.stdout.write(`wrote ${target}\n`);
