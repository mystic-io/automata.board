/**
 * Vivia MVP — Gig Tunnel Durable Object
 *
 * Ephemeral WebSocket relay connecting Buyer and Worker agents.
 */

export class GigTunnel {
  private state: DurableObjectState;
  
  constructor(state: DurableObjectState, env: any) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      return new Response('Expected Upgrade: websocket', { status: 426 });
    }

    // Accept the WebSocket connection
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    // Accept using Hibernation API
    this.state.acceptWebSocket(server);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  // Durable Object Hibernation API WebSocket handlers
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // Broadcast message to all OTHER connected websockets
    const sockets = this.state.getWebSockets();
    for (const socket of sockets) {
      if (socket !== ws) {
        try {
          socket.send(message);
        } catch (err) {
          console.error('Failed to send message to a socket', err);
        }
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    // A client disconnected. The Hibernation API automatically removes it.
    console.log(`WebSocket closed: ${code} ${reason}`);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error(`WebSocket error:`, error);
  }
}
