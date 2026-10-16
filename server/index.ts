import { DEFAULT_PORT } from '../src/net/protocol';
import { VERSION } from '../src/net/version';
import { createServer } from './app';

const port = Number(process.env.PORT ?? DEFAULT_PORT);
await createServer().listen(port);
console.log(`1v1me v${VERSION} server listening on ws://localhost:${port}`);
