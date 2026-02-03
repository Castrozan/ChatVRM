/**
 * Avatar WebSocket Client
 * Connects to the control server and handles incoming commands
 */

export interface CommandMessage {
  type: 'speak' | 'setExpression' | 'setIdle' | 'getStatus';
  [key: string]: any;
}

export interface SpeakCommand extends CommandMessage {
  type: 'speak';
  text: string;
  emotion: string;
  audioUrl: string;
}

export interface ExpressionCommand extends CommandMessage {
  type: 'setExpression';
  name: string;
  intensity?: number;
}

export interface IdleCommand extends CommandMessage {
  type: 'setIdle';
  mode: 'breathing' | 'thinking' | 'waiting' | 'excited';
}

export type CommandHandler = (command: CommandMessage) => void | Promise<void>;
export type ConnectionHandler = (connected: boolean) => void;

export class AvatarClient {
  private ws: WebSocket | null = null;
  private url: string;
  private reconnectInterval: number = 5000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connected: boolean = false;
  private destroyed: boolean = false;
  private commandHandlers: CommandHandler[] = [];
  private connectionHandlers: ConnectionHandler[] = [];

  constructor(url: string = 'ws://localhost:8765') {
    this.url = url;
  }

  public connect(): void {
    if (this.destroyed) {
      console.log('Client destroyed, not reconnecting');
      return;
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      console.log('Already connected to avatar control server');
      return;
    }

    console.log(`Connecting to avatar control server at ${this.url}...`);
    
    try {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        console.log('✅ Connected to avatar control server');
        this.connected = true;
        this.notifyConnectionChange(true);
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        // Identify as renderer to the control server
        this.ws?.send(JSON.stringify({ type: 'identify', role: 'renderer' }));
        console.log('📤 Sent renderer identification');
      };

      this.ws.onmessage = (event) => {
        try {
          const command = JSON.parse(event.data) as CommandMessage;
          console.log('Received command:', command);
          this.handleCommand(command);
        } catch (error) {
          console.error('Failed to parse command:', error);
        }
      };

      this.ws.onerror = (error) => {
        console.error('WebSocket error:', error);
      };

      this.ws.onclose = () => {
        console.log('Disconnected from avatar control server');
        this.connected = false;
        this.notifyConnectionChange(false);
        this.scheduleReconnect();
      };
    } catch (error) {
      console.error('Failed to connect:', error);
      this.scheduleReconnect();
    }
  }

  public disconnect(): void {
    this.destroyed = true;
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    if (this.ws) {
      // Remove handlers BEFORE closing to prevent zombie reconnections
      this.ws.onopen = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.close();
      this.ws = null;
    }
    
    this.connected = false;
  }

  public isConnected(): boolean {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }

  public onCommand(handler: CommandHandler): void {
    this.commandHandlers.push(handler);
  }

  public onConnectionChange(handler: ConnectionHandler): void {
    this.connectionHandlers.push(handler);
  }

  private notifyConnectionChange(connected: boolean): void {
    for (const handler of this.connectionHandlers) {
      try {
        handler(connected);
      } catch (error) {
        console.error('Connection handler error:', error);
      }
    }
  }

  public send(message: any): void {
    if (!this.isConnected()) {
      console.warn('Cannot send message: not connected');
      return;
    }

    try {
      this.ws?.send(JSON.stringify(message));
    } catch (error) {
      console.error('Failed to send message:', error);
    }
  }

  private handleCommand(command: CommandMessage): void {
    for (const handler of this.commandHandlers) {
      try {
        handler(command);
      } catch (error) {
        console.error('Command handler error:', error);
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return; // Already scheduled
    }

    console.log(`Reconnecting in ${this.reconnectInterval / 1000}s...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectInterval);
  }
}
