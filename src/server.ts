import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import { messageType } from './types';
import { routeMessage } from './router';
import { disconnectPlayer } from './gameRoom';

const httpServer = createServer();
const io = new Server(httpServer, {
  cors: { origin: '*' }
});

io.on('connection', (socket: Socket) => {
  console.log('player connected:', socket.id);

  socket.on('disconnect', () => {
    console.log('player disconnected:', socket.id);
    disconnectPlayer(socket,io);
  });

  socket.on('message', (raw: any) => {
    const message: messageType = typeof raw === 'string' ? JSON.parse(raw) : raw;
    routeMessage(message, socket, io);
  });
});

httpServer.listen(3001, '0.0.0.0', () => {
  console.log('Server running on port 3001');
});