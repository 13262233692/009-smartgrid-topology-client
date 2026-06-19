import type {
  GooseMessage,
  SvMessage,
  ConnectionStatus,
  MessageStatistics,
  AggregatedEvent,
  AggregatedGooseMessage,
  AggregatedSvMessage,
  StormWarningMessage,
} from '../models/types';

type GooseCallback = (msg: GooseMessage) => void;
type SvCallback = (msg: SvMessage) => void;
type StatusCallback = (status: ConnectionStatus) => void;
type StormCallback = (msg: StormWarningMessage) => void;

const MAX_QUEUE_SIZE = 4096;
const DEFAULT_MAX_PER_FRAME = 64;

class DataService {
  private static instance: DataService;
  private ws: WebSocket | null = null;
  private url: string = 'ws://localhost:9502';
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay: number = 1000;
  private maxReconnectDelay: number = 30000;
  private reconnectAttempt: number = 0;

  private pendingQueue: AggregatedEvent[] = [];
  private gooseBuffer: GooseMessage[] = [];
  private svBuffer: SvMessage[] = [];
  private maxGooseBuffer = 100;
  private maxSvBuffer = 1000;

  private gooseCallbacks: Set<GooseCallback> = new Set();
  private svCallbacks: Set<SvCallback> = new Set();
  private statusCallbacks: Set<StatusCallback> = new Set();
  private stormCallbacks: Set<StormCallback> = new Set();

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
    queueSize: 0,
    processedPerFrame: 0,
    stormActive: false,
    stormGooseRate: 0,
    stormSvRate: 0,
  };
  private stormEndTimer: ReturnType<typeof setTimeout> | null = null;

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
      const raw = JSON.parse(event.data as string) as AggregatedEvent;
      if (this.pendingQueue.length >= MAX_QUEUE_SIZE) {
        const dropped = this.pendingQueue.splice(0, Math.floor(MAX_QUEUE_SIZE / 4));
        (window as any)._queueDropped = dropped.length;
      }
      this.pendingQueue.push(raw);
    } catch (e) {
      (window as any)._parseError = String(e);
      (window as any)._rawMsg = event.data;
    }
  }

  processBatch(maxPerFrame: number = DEFAULT_MAX_PER_FRAME): number {
    if (this.pendingQueue.length === 0) {
      this._stats.queueSize = 0;
      this._stats.processedPerFrame = 0;
      return 0;
    }

    const deadline = performance.now() + 10;
    const count = Math.min(maxPerFrame, this.pendingQueue.length);
    let processed = 0;

    while (processed < count && performance.now() < deadline) {
      const ev = this.pendingQueue.shift();
      if (!ev) break;

      switch (ev.aggType) {
        case 'goose':
          this.handleGoose(ev as AggregatedGooseMessage);
          break;
        case 'sv':
          this.handleSv(ev as AggregatedSvMessage);
          break;
        case 'storm':
          this.handleStorm(ev as StormWarningMessage);
          break;
      }
      processed++;
    }

    this._stats.queueSize = this.pendingQueue.length;
    this._stats.processedPerFrame = processed;
    return processed;
  }

  private handleGoose(msg: AggregatedGooseMessage): void {
    const gooseData: GooseMessage = {
      goId: msg.goId,
      gocbRef: msg.gocbRef,
      stNum: msg.stNum,
      sqNum: msg.sqNum,
      timestamp: msg.timestamp,
      datasetRef: msg.datasetRef,
      breakerStatuses: msg.breakerStatuses,
    };
    this.gooseBuffer.push(gooseData);
    if (this.gooseBuffer.length > this.maxGooseBuffer) {
      this.gooseBuffer.shift();
    }
    this._stats.gooseCount++;
    this._stats.lastGooseTimestamp = msg.timestamp;
    this.gooseCallbacks.forEach((cb) => cb(gooseData));
  }

  private handleSv(msg: AggregatedSvMessage): void {
    const svData: SvMessage = {
      smpCnt: msg.smpCnt,
      smpMod: msg.smpMod,
      smpRate: msg.smpRate,
      voltageChannels: msg.voltageChannels,
      currentChannels: msg.currentChannels,
      timestamp: msg.timestamp,
    };
    this.svBuffer.push(svData);
    if (this.svBuffer.length > this.maxSvBuffer) {
      this.svBuffer.shift();
    }
    this._stats.svCount++;
    this._stats.lastSvTimestamp = msg.timestamp;
    this.svCallbacks.forEach((cb) => cb(svData));
  }

  private handleStorm(msg: StormWarningMessage): void {
    this._stats.stormActive = true;
    this._stats.stormGooseRate = msg.gooseRate;
    this._stats.stormSvRate = msg.svRate;
    if (this.stormEndTimer) clearTimeout(this.stormEndTimer);
    this.stormEndTimer = setTimeout(() => {
      this._stats.stormActive = false;
      this._stats.stormGooseRate = 0;
      this._stats.stormSvRate = 0;
    }, 2500);
    this.stormCallbacks.forEach((cb) => cb(msg));
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
    if (this.stormEndTimer) {
      clearTimeout(this.stormEndTimer);
      this.stormEndTimer = null;
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

  onStormWarning(callback: StormCallback): () => void {
    this.stormCallbacks.add(callback);
    return () => this.stormCallbacks.delete(callback);
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

  getQueueSize(): number {
    return this.pendingQueue.length;
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
