import type {
  SubstationEvent,
  GooseMessage,
  SvMessage,
  ConnectionStatus,
  MessageStatistics,
} from '../models/types';

type GooseCallback = (msg: GooseMessage) => void;
type SvCallback = (msg: SvMessage) => void;
type StatusCallback = (status: ConnectionStatus) => void;

class DataService {
  private static instance: DataService;
  private ws: WebSocket | null = null;
  private url: string = 'ws://localhost:9502';
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay: number = 1000;
  private maxReconnectDelay: number = 30000;
  private reconnectAttempt: number = 0;
  private gooseBuffer: GooseMessage[] = [];
  private svBuffer: SvMessage[] = [];
  private maxGooseBuffer = 100;
  private maxSvBuffer = 1000;
  private gooseCallbacks: Set<GooseCallback> = new Set();
  private svCallbacks: Set<SvCallback> = new Set();
  private statusCallbacks: Set<StatusCallback> = new Set();
  private _status: ConnectionStatus = {
    connected: false,
    url: this.url,
    reconnectAttempt: 0,
    lastConnected: null,
  };
  private _stats: MessageStatistics = {
    gooseCount: 0,
    svCount: 0,
    lastGooseTimestamp: null,
    lastSvTimestamp: null,
  };

  private constructor() {}

  static getInstance(): DataService {
    if (!DataService.instance) {
      DataService.instance = new DataService();
      (window as any)._ds = DataService.instance;
    }
    return DataService.instance;
  }

  connect(url?: string): void {
    if (url) {
      this.url = url;
      this._status.url = url;
    }
    this.cleanup();
    this.tryConnect();
  }

  private tryConnect(): void {
    try {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = this.onOpen.bind(this);
      this.ws.onmessage = this.onMessage.bind(this);
      this.ws.onclose = this.onClose.bind(this);
      this.ws.onerror = this.onError.bind(this);
    } catch {
      this.scheduleReconnect();
    }
  }

  private onOpen(): void {
    this.reconnectDelay = 1000;
    this.reconnectAttempt = 0;
    this._status.connected = true;
    this._status.lastConnected = Date.now();
    this._status.reconnectAttempt = 0;
    this.notifyStatus();
  }

  private onMessage(event: MessageEvent): void {
    try {
      const raw = JSON.parse(event.data as string) as SubstationEvent;
      if (raw.type === 'goose') {
        const { type: _, ...gooseData } = raw;
        this.handleGoose(gooseData as GooseMessage);
      } else if (raw.type === 'sv') {
        const { type: _, ...svData } = raw;
        this.handleSv(svData as SvMessage);
      } else {
        (window as any)._unknownType = (raw as any).type;
      }
    } catch (e) {
      (window as any)._parseError = String(e);
      (window as any)._rawMsg = event.data;
    }
  }

  private handleGoose(msg: GooseMessage): void {
    this.gooseBuffer.push(msg);
    if (this.gooseBuffer.length > this.maxGooseBuffer) {
      this.gooseBuffer.shift();
    }
    this._stats.gooseCount++;
    this._stats.lastGooseTimestamp = msg.timestamp;
    this.gooseCallbacks.forEach((cb) => cb(msg));
  }

  private handleSv(msg: SvMessage): void {
    this.svBuffer.push(msg);
    if (this.svBuffer.length > this.maxSvBuffer) {
      this.svBuffer.shift();
    }
    this._stats.svCount++;
    this._stats.lastSvTimestamp = msg.timestamp;
    this.svCallbacks.forEach((cb) => cb(msg));
  }

  private onClose(): void {
    this._status.connected = false;
    this.notifyStatus();
    this.scheduleReconnect();
  }

  private onError(): void {
    this._status.connected = false;
    this.notifyStatus();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectAttempt++;
    this._status.reconnectAttempt = this.reconnectAttempt;
    this.notifyStatus();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.tryConnect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }

  private cleanup(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }
  }

  private notifyStatus(): void {
    this.statusCallbacks.forEach((cb) => cb({ ...this._status }));
  }

  onGoose(callback: GooseCallback): () => void {
    this.gooseCallbacks.add(callback);
    return () => this.gooseCallbacks.delete(callback);
  }

  onSv(callback: SvCallback): () => void {
    this.svCallbacks.add(callback);
    return () => this.svCallbacks.delete(callback);
  }

  onStatusChange(callback: StatusCallback): () => void {
    this.statusCallbacks.add(callback);
    return () => this.statusCallbacks.delete(callback);
  }

  getStatus(): ConnectionStatus {
    return { ...this._status };
  }

  getStats(): MessageStatistics {
    return { ...this._stats };
  }

  getGooseBuffer(): GooseMessage[] {
    return [...this.gooseBuffer];
  }

  getSvBuffer(): SvMessage[] {
    return [...this.svBuffer];
  }

  disconnect(): void {
    this.cleanup();
    this._status.connected = false;
    this.reconnectDelay = 1000;
    this.reconnectAttempt = 0;
    this.notifyStatus();
  }
}

export default DataService;
