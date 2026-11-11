// Test helper: runs the app against the database in DATABASE_PATH on an
// ephemeral loopback port and reports the port on stdout.
import { app } from '../../src/app.js';

const server = app.listen(0, '127.0.0.1', () => {
  process.stdout.write(`PORT=${server.address().port}\n`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
