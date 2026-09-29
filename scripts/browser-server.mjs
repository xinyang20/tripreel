import { createTravelServer } from '../server.mjs';
// An isolated source with no external calls; browser tests provide deterministic API responses.
const server = await createTravelServer({
  fetchImpl: async () => {
    throw new Error('浏览器验收使用模拟来源。');
  },
});
server.listen(43717, '127.0.0.1', () =>
  console.log('Isolated test server: http://127.0.0.1:43717'),
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    server.closeAllConnections();
    server.close(() => process.exit(0));
  });
