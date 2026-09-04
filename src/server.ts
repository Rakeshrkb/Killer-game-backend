import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import { messageType } from './types';
import { routeMessage } from './router';
import { disconnectPlayer } from './gameRoomInRedis';
import { loadCount, saveCount } from './utils';
import { startRotationSweep } from './rotationScheduler';
import { startRespawnSweep } from './respawnScheduler';
import { startRematchSweep } from './rematchScheduler';
import { resolveRematchWindow } from './gameRoomInRedis';
import { redis, subClient } from "./redisClient";
import { createAdapter } from '@socket.io/redis-adapter';
const ALLOWED_ORIGINS = [
  'https://puke222earn-killer-game-lobby.kill-your-friend.workers.dev',
  'https://game.kill-your-friend.workers.dev',
];

let visitorCount = loadCount();
const httpServer = createServer((req, res) => {
  const origin = req.headers.origin;
  const corsHeaders: Record<string, string> = {};
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    corsHeaders['Access-Control-Allow-Origin'] = origin;
  }

  try {
    if (req.method === 'GET' && req.url === '/api/visit') {
      visitorCount++;
      saveCount(visitorCount);
      res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify({ count: visitorCount }));
      return;
    }

    if (req.method === 'GET' && req.url === '/api/stats') {
      const onlineCount = io.engine.clientsCount;
      res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify({ online: onlineCount, totalVisits: visitorCount }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json', ...corsHeaders });
    res.end(JSON.stringify({ error: 'Not found' }));
  } catch (err) {
    console.error('HTTP handler error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
    res.end(JSON.stringify({ error: 'Internal error' }));
  }
});
const io = new Server(httpServer, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ['GET', 'POST'],
  },
  adapter: createAdapter(redis, subClient),
});
startRotationSweep(io);
startRespawnSweep(io);
startRematchSweep(io, resolveRematchWindow);

io.on('connection', (socket: Socket) => {

  socket.on('disconnect', () => {
    disconnectPlayer(socket, io);
  });

  socket.on('message', (raw: any) => {
    const message: messageType = typeof raw === 'string' ? JSON.parse(raw) : raw;
    routeMessage(message, socket, io);
  });
});

redis.on('error', (err) => console.error('Redis pub client error:', err));
subClient.on('error', (err) => console.error('Redis sub client error:', err));

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  httpServer.close();
  await redis.quit();
  await subClient.quit();
  process.exit(0);
});

httpServer.listen(3001, '0.0.0.0', () => {
  console.log("--------------------------------");
  console.log('WS Server running on port 3001');
  console.log("--------------------------------");
});