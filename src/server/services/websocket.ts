import type { WebSocket } from 'ws';
import type { WsEvent } from '../types.js';

// Store connected clients
const clients: Set<WebSocket> = new Set();

export function addClient(ws: WebSocket): void {
  clients.add(ws);
  console.log(`Client connected. Total clients: ${clients.size}`);

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`Client disconnected. Total clients: ${clients.size}`);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    clients.delete(ws);
  });
}

export function broadcast(event: WsEvent): void {
  const message = JSON.stringify(event);
  
  for (const client of clients) {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(message);
    }
  }
}

export function getClientCount(): number {
  return clients.size;
}
