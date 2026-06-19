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
  private islandSectionEl: HTMLElement | null = null;
  private islandCountBadgeEl: HTMLElement | null = null;
  private islandStatCountEl: HTMLElement | null = null;
  private islandStatDevicesEl: HTMLElement | null = null;
  private islandStatRegionsEl: HTMLElement | null = null;
  private islandListEl: HTMLElement | null = null;
  private lastIslandCount: number = -1;

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

    this.islandSectionEl = document.getElementById('island-section');
    this.islandCountBadgeEl = document.getElementById('island-count-badge');
    this.islandStatCountEl = document.getElementById('island-stat-count');
    this.islandStatDevicesEl = document.getElementById('island-stat-devices');
    this.islandStatRegionsEl = document.getElementById('island-stat-regions');
    this.islandListEl = document.getElementById('island-list');

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
    let frame = 0;
    const loop = () => {
      this.dataService.processBatch(80);
      this.sldRenderer?.render();
      this.waveformRenderer?.render();
      this.updateStatusPanels();
      this.updateStormBanner();
      this.updateIslandPanel();
      frame++;
      if (frame % 60 === 0) {
        this.updateGooseListBatch();
      }
      this.animationFrameId = requestAnimationFrame(loop);
    };
    this.animationFrameId = requestAnimationFrame(loop);
  }

  private pendingGooseList: GooseMessage[] = [];

  private updateGooseList(msg: GooseMessage): void {
    this.pendingGooseList.push(msg);
    if (this.pendingGooseList.length > 20) {
      this.pendingGooseList.splice(0, this.pendingGooseList.length - 10);
    }
  }

  private updateGooseListBatch(): void {
    if (this.pendingGooseList.length === 0 || !this.gooseListEl) return;
    const list = this.pendingGooseList;
    this.pendingGooseList = [];
    const frag = document.createDocumentFragment();
    for (let idx = 0; idx < list.length; idx++) {
      const msg = list[idx];
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
      frag.appendChild(item);
    }
    this.gooseListEl.insertBefore(frag, this.gooseListEl.firstChild);
    while (this.gooseListEl.children.length > 50) {
      this.gooseListEl.removeChild(this.gooseListEl.lastChild!);
    }
  }

  private updateStormBanner(): void {
    const banner = document.getElementById('storm-banner');
    if (!banner) return;
    const stats = this.dataService.getStats();
    if (stats.stormActive) {
      banner.style.display = 'block';
      banner.innerHTML = `⚠️ GOOSE事件风暴检测中 | GOOSE: ${stats.stormGooseRate.toFixed(0)}/s | SV: ${stats.stormSvRate.toFixed(0)}/s | 队列: ${stats.queueSize}`;
      banner.className = 'storm-banner active';
    } else {
      banner.style.display = 'none';
      banner.className = 'storm-banner';
    }
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

  private updateIslandPanel(): void {
    if (!this.islandSectionEl) return;
    const analysis = this.sldRenderer?.getLastAnalysis();
    if (!analysis) return;

    const activeIslands = analysis.islands.filter((i) => !i.hasSource);
    const islandCount = activeIslands.length;
    const isolatedDevices = analysis.isolatedCount;
    const totalRegions = analysis.islands.length + 1;

    if (this.islandCountBadgeEl) {
      this.islandCountBadgeEl.textContent = String(islandCount);
      this.islandCountBadgeEl.style.backgroundColor = islandCount > 0 ? '#ff6b35' : '';
    }

    if (this.islandStatCountEl) {
      const valEl = this.islandStatCountEl.querySelector('.island-stat-value');
      if (valEl) valEl.textContent = String(islandCount);
      if (islandCount > 0) this.islandStatCountEl.classList.add('alarm');
      else this.islandStatCountEl.classList.remove('alarm');
    }
    if (this.islandStatDevicesEl) {
      const valEl = this.islandStatDevicesEl.querySelector('.island-stat-value');
      if (valEl) valEl.textContent = String(isolatedDevices);
      if (isolatedDevices > 0) this.islandStatDevicesEl.classList.add('alarm');
      else this.islandStatDevicesEl.classList.remove('alarm');
    }
    if (this.islandStatRegionsEl) {
      const valEl = this.islandStatRegionsEl.querySelector('.island-stat-value');
      if (valEl) valEl.textContent = String(totalRegions);
    }

    if (islandCount > 0) {
      this.islandSectionEl.classList.add('active');
    } else {
      this.islandSectionEl.classList.remove('active');
    }

    if (islandCount !== this.lastIslandCount && this.islandListEl) {
      this.lastIslandCount = islandCount;
      const listEl = this.islandListEl;
      listEl.innerHTML = '';
      const comps = this.sldRenderer?.getComponents() || [];

      for (const il of activeIslands) {
        const card = document.createElement('div');
        card.className = 'island-card' + (il.type === 'grounded' ? ' grounded' : '');

        const labels = il.memberIds
          .slice(0, 12)
          .map((mid) => {
            const c = comps.find((cc) => cc.id === mid);
            const lbl = c?.label || mid.replace(/_/g, ' ');
            return `<span class="island-member-tag">${lbl}</span>`;
          })
          .join('');
        const more = il.memberIds.length > 12 ? ` <span class="island-member-tag" style="opacity:0.6">+${il.memberIds.length - 12}</span>` : '';

        const typeLabel = il.type === 'grounded' ? '接地孤岛' : '供电孤岛';
        const header = `▼ 孤岛#${il.id} · ${typeLabel}`;

        card.innerHTML = `
          <div class="island-card-header">
            <span class="island-card-title">${header}</span>
            <span class="island-card-size">${il.size} 设备</span>
          </div>
          <div class="island-card-members">${labels}${more}</div>
        `;
        listEl.appendChild(card);
      }
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
