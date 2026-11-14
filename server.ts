import { startStandaloneServers } from './backend/src/server.ts';

startStandaloneServers().catch((err) => {
  console.error('[Sam_Att V2 Standalone] Fatal startup error:', err);
  process.exit(1);
});
