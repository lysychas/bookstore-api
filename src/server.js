import app from './app.js';

const port = parseInt(process.env.PORT || '3000', 10);
const host = process.env.BIND_ADDRESS || '127.0.0.1';

const server = app.listen(port, host, () => {
  console.log(`Bookstore API listening on http://${host}:${port}`);
});

// Graceful shutdown
const shutdown = (signal) => {
  console.log(`${signal} received: closing HTTP server`);
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
