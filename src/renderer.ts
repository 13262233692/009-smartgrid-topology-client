import SldRenderer from './canvas/sld-renderer';
import WaveformRenderer from './canvas/waveform';
import DataService from './services/data-service';
import type { GooseMessage, SvMessage, ConnectionStatus } from './models/types';

class App {
  private sldRenderer: SldRenderer | null = null;
  private waveformRenderer: WaveformRenderer | null = null;
  private dataService: DataService;
  private animationFrameId: number = 0;
  private gooseListEl: HTMLElement | null = null;
  private connectionHeaderEl: HTMLElement | null = null;
  private wsStatusEl: HTMLElement | null = null;
  private gooseTotalEl: HTMLElement | null = null;
  private svTotalEl: HTMLElement | null = null;
  private reconnectEl: HTMLElement | null = null;
  private gooseCountBadgeEl: HTMLElement | null = null;

  constructor() {
    this.dataService = DataService.getInstance();
  }

  init(): void {
    const sldCanvas = document.getElementById('sld-canvas') as HTMLCanvasElement;
    const waveformCanvas = document.getElementById('waveform-canvas') as HTMLCanvasElement;
    this.gooseListEl = document.getElementById('goose-list');
    this.connectionHeaderEl = document.getElementById('connection-status');
    this.wsStatusEl = document.getElementById('ws-status');
    this.gooseTotalEl = document.getElementById('goose-total');
    this.svTotalEl = document.getElementById('sv-total');
    this.reconnectEl = document.getElementById('reconnect-attempts');
    this.gooseCountBadgeEl = document.getElementById('goose-count');

    if (sldCanvas) {
      const parent = sldCanvas.parentElement!;
      this.sldRenderer = new SldRenderer(sldCanvas);
      this.sldRenderer.resize(parent.clientWidth, parent.clientHeight);
    }

    if (waveformCanvas) {
      const parent = waveformCanvas.parentElement!;
      this.waveformRenderer = new WaveformRenderer(waveformCanvas);
      this.waveformRenderer.resize(parent.clientWidth, parent.clientHeight);
    }

    this.dataService.onGoose(this.onGoose.bind(this));
    this.dataService.onSv(this.onSv.bind(this));
    this.dataService.onStatusChange(this.onStatusChange.bind(this));

    this.dataService.connect();

    window.addEventListener('resize', this.onResize.bind(this));
    this.startAnimationLoop();
  }

  private onGoose(msg: GooseMessage): void {
    this.sldRenderer?.updateBreakerStates(msg.breakerStatuses);
    this.updateGooseList(msg);
    this.updateGooseBadge();
  }

  private onSv(msg: SvMessage): void {
    this.waveformRenderer?.addSvData(msg);
  }

  private onStatusChange(status: ConnectionStatus): void {
    if (this.connectionHeaderEl) {
      const dot = status.connected
        ? '<span class="status-dot connected"></span>'
        : '<span class="status-dot"></span>';
      const text = status.connected
        ? 'Connected'
        : `Disconnected (retry #${status.reconnectAttempt})`;
      this.connectionHeaderEl.innerHTML = `${dot} ${text}`;
    }

    if (this.wsStatusEl) {
      this.wsStatusEl.textContent = status.connected ? 'Connected' : 'Disconnected';
      this.wsStatusEl.className = 'status-value ' + (status.connected ? 'green' : 'red');
    }

    if (this.reconnectEl) {
      this.reconnectEl.textContent = String(status.reconnectAttempt);
    }
  }

  private updateGooseBadge(): void {
    if (!this.gooseCountBadgeEl) return;
    const stats = this.dataService.getStats();
    this.gooseCountBadgeEl.textContent = String(stats.gooseCount);
  }

  private updateGooseList(msg: GooseMessage): void {
    if (!this.gooseListEl) return;

    const item = document.createElement('div');
    item.className = 'goose-item';

    const d = new Date(msg.timestamp);
    const time = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}.${d.getMilliseconds().toString().padStart(3, '0')}`;

    const breakerSummary = Object.entries(msg.breakerStatuses)
      .map(([id, st]) => {
        const shortId = id.replace('brk_', '').replace(/_/g, '').toUpperCase();
        const color = st === 'closed' ? '#00ff88' : st === 'open' ? '#ff4444' : '#ffaa00';
        const symbol = st === 'closed' ? '[X]' : st === 'open' ? '[ ]' : '[~]';
        return `<span style="color:${color}">${shortId}${symbol}</span>`;
      })
      .join(' ');

    item.innerHTML = `
      <div class="goose-header">
        <span class="goose-id">${msg.goId}</span>
        <span class="goose-time">${time}</span>
      </div>
      <div class="goose-detail">stNum:${msg.stNum} sqNum:${msg.sqNum}</div>
      <div class="goose-breakers">${breakerSummary}</div>
    `;

    this.gooseListEl.insertBefore(item, this.gooseListEl.firstChild);

    while (this.gooseListEl.children.length > 50) {
      this.gooseListEl.removeChild(this.gooseListEl.lastChild!);
    }
  }

  private onResize(): void {
    const sldCanvas = document.getElementById('sld-canvas') as HTMLCanvasElement;
    const waveformCanvas = document.getElementById('waveform-canvas') as HTMLCanvasElement;

    if (sldCanvas && this.sldRenderer) {
      const parent = sldCanvas.parentElement!;
      this.sldRenderer.resize(parent.clientWidth, parent.clientHeight);
    }

    if (waveformCanvas && this.waveformRenderer) {
      const parent = waveformCanvas.parentElement!;
      this.waveformRenderer.resize(parent.clientWidth, parent.clientHeight);
    }
  }

  private startAnimationLoop(): void {
    const loop = () => {
      this.sldRenderer?.render();
      this.waveformRenderer?.render();
      this.updateStatusPanels();
      this.animationFrameId = requestAnimationFrame(loop);
    };
    this.animationFrameId = requestAnimationFrame(loop);
  }

  private updateStatusPanels(): void {
    const statsEl = document.getElementById('stats-bar');
    const stats = this.dataService.getStats();

    if (statsEl) {
      const lastGooseTime = stats.lastGooseTimestamp
        ? new Date(stats.lastGooseTimestamp).toLocaleTimeString()
        : 'N/A';
      statsEl.textContent = `GOOSE: ${stats.gooseCount} | SV: ${stats.svCount} | Last GOOSE: ${lastGooseTime}`;
    }

    if (this.gooseTotalEl) {
      this.gooseTotalEl.textContent = String(stats.gooseCount);
    }
    if (this.svTotalEl) {
      this.svTotalEl.textContent = String(stats.svCount);
    }
  }

  destroy(): void {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }
    this.dataService.disconnect();
    window.removeEventListener('resize', this.onResize.bind(this));
  }
}

const app = new App();
document.addEventListener('DOMContentLoaded', () => {
  app.init();
});
