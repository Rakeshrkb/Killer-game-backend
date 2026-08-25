import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import { messageType } from './types';
import { routeMessage } from './router';
import { disconnectPlayer } from './gameRoom';
import { loadCount, saveCount } from './utils';

let visitorCount = loadCount();
const httpServer = createServer((req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/api/visit') {
      visitorCount++;
      saveCount(visitorCount);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ count: visitorCount }));
      return;
    }

    if (req.method === 'GET' && req.url === '/api/stats') {
      const onlineCount = io.engine.clientsCount;
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ online: onlineCount, totalVisits: visitorCount }));
      return;
    }

    // no matching route
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  } catch (err) {
    console.error('HTTP handler error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal error' }));
  }
});
const io = new Server(httpServer, {
  cors: { origin: '*' }
});

io.on('connection', (socket: Socket) => {

  socket.on('disconnect', () => {
    disconnectPlayer(socket, io);
  });

  socket.on('message', (raw: any) => {
    const message: messageType = typeof raw === 'string' ? JSON.parse(raw) : raw;
    routeMessage(message, socket, io);
  });
});

httpServer.listen(3001, '0.0.0.0', () => {
  console.log('Server running on port 3001');
});