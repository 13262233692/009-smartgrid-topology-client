import type { SldComponent, SldConnection, BreakerStatus } from '../models/types';
import TopologyEngine from './topology';

const COLORS = {
  energized: '#00ff88',
  deEnergized: '#444444',
  breakerClosed: '#00ff88',
  breakerOpen: '#ff4444',
  breakerIntermediate: '#ffaa00',
  breakerInvalid: '#ff4444',
  busbar: '#00ff88',
  busbarDe: '#444444',
  text: '#cccccc',
  labelText: '#888888',
  grid: '#1a2030',
  background: '#0d1117',
  connection: '#3366aa',
  connectionDe: '#222233',
  transformer: '#00aaff',
  line: '#ffaa00',
  ground: '#666666',
};

class SldRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private topology: TopologyEngine;
  private components: SldComponent[] = [];
  private connections: SldConnection[] = [];
  private breakerStates: Map<string, BreakerStatus> = new Map();
  private pendingBreakerStates: Record<string, BreakerStatus> = {};
  private pendingDirty: boolean = false;
  private energizedMap: Map<string, boolean> = new Map();
  private dpr: number = 1;
  private scaleX: number = 1;
  private scaleY: number = 1;
  private baseW: number = 1040;
  private baseH: number = 720;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d')!;
    this.ctx = ctx;
    this.topology = new TopologyEngine();
    this.dpr = window.devicePixelRatio || 1;
    this.initSubstation();
  }

  private initSubstation(): void {
    const c = (id: string, type: SldComponent['type'], x: number, y: number, w: number, h: number, label: string, ports: SldComponent['ports']): SldComponent => ({
      id, type, x, y, width: w, height: h, label, energized: true, ports,
    });

    this.components = [
      c('line_220_1', 'line', 160, 30, 10, 60, 'L1', { bottom: 'line_220_1_b' }),
      c('line_220_2', 'line', 320, 30, 10, 60, 'L2', { bottom: 'line_220_2_b' }),

      c('bus_220_a', 'busbar', 60, 110, 920, 22, '220kV I 母', { bottom: 'bus_220_a_b', top: 'bus_220_a_t' }),
      c('bus_220_b', 'busbar', 60, 220, 920, 22, '220kV II 母', { top: 'bus_220_b_t', bottom: 'bus_220_b_b' }),

      c('brk_220_a_sec1', 'breaker', 148, 132, 34, 34, 'Q1', { top: 'brk_220_a_sec1_t', bottom: 'brk_220_a_sec1_b' }),
      c('brk_220_a_sec2', 'breaker', 308, 132, 34, 34, 'Q2', { top: 'brk_220_a_sec2_t', bottom: 'brk_220_a_sec2_b' }),

      c('disc_220_a1', 'disconnector', 156, 175, 18, 18, 'D1', { top: 'disc_220_a1_t', bottom: 'disc_220_a1_b' }),
      c('disc_220_a2', 'disconnector', 316, 175, 18, 18, 'D2', { top: 'disc_220_a2_t', bottom: 'disc_220_a2_b' }),

      c('brk_220_b_sec1', 'breaker', 148, 242, 34, 34, 'Q3', { top: 'brk_220_b_sec1_t', bottom: 'brk_220_b_sec1_b' }),
      c('brk_220_b_sec2', 'breaker', 308, 242, 34, 34, 'Q4', { top: 'brk_220_b_sec2_t', bottom: 'brk_220_b_sec2_b' }),

      c('brk_220_coupler', 'breaker', 468, 132, 34, 34, 'Q9', { top: 'brk_220_coupler_t', bottom: 'brk_220_coupler_b' }),

      c('brk_xfmr1_hv', 'breaker', 648, 132, 34, 34, 'Q5', { top: 'brk_xfmr1_hv_t', bottom: 'brk_xfmr1_hv_b' }),
      c('brk_xfmr2_hv', 'breaker', 808, 132, 34, 34, 'Q6', { top: 'brk_xfmr2_hv_t', bottom: 'brk_xfmr2_hv_b' }),

      c('xfmr1', 'transformer', 638, 290, 54, 100, 'T1', { top: 'xfmr1_t', bottom: 'xfmr1_b' }),
      c('xfmr2', 'transformer', 798, 290, 54, 100, 'T2', { top: 'xfmr2_t', bottom: 'xfmr2_b' }),

      c('brk_xfmr1_lv', 'breaker', 648, 420, 34, 34, 'Q7', { top: 'brk_xfmr1_lv_t', bottom: 'brk_xfmr1_lv_b' }),
      c('brk_xfmr2_lv', 'breaker', 808, 420, 34, 34, 'Q8', { top: 'brk_xfmr2_lv_t', bottom: 'brk_xfmr2_lv_b' }),

      c('bus_110_a', 'busbar', 60, 480, 920, 22, '110kV I 母', { top: 'bus_110_a_t', bottom: 'bus_110_a_b' }),
      c('bus_110_b', 'busbar', 60, 580, 920, 22, '110kV II 母', { top: 'bus_110_b_t', bottom: 'bus_110_b_b' }),

      c('disc_110_a1', 'disconnector', 156, 510, 18, 18, 'D3', { top: 'disc_110_a1_t', bottom: 'disc_110_a1_b' }),
      c('disc_110_a2', 'disconnector', 316, 510, 18, 18, 'D4', { top: 'disc_110_a2_t', bottom: 'disc_110_a2_b' }),

      c('brk_110_coupler', 'breaker', 468, 502, 34, 34, 'Q10', { top: 'brk_110_coupler_t', bottom: 'brk_110_coupler_b' }),

      c('line_110_1', 'line', 160, 610, 10, 56, 'L3', { top: 'line_110_1_t', bottom: 'line_110_1_b' }),
      c('line_110_2', 'line', 320, 610, 10, 56, 'L4', { top: 'line_110_2_t', bottom: 'line_110_2_b' }),

      c('gnd_1', 'ground', 160, 670, 10, 22, '', { top: 'gnd_1_t' }),
      c('gnd_2', 'ground', 320, 670, 10, 22, '', { top: 'gnd_2_t' }),
    ];

    this.connections = [
      { from: { componentId: 'line_220_1', port: 'bottom' }, to: { componentId: 'bus_220_a', port: 'top' } },
      { from: { componentId: 'line_220_2', port: 'bottom' }, to: { componentId: 'bus_220_a', port: 'top' } },

      { from: { componentId: 'bus_220_a', port: 'bottom' }, to: { componentId: 'brk_220_a_sec1', port: 'top' } },
      { from: { componentId: 'brk_220_a_sec1', port: 'bottom' }, to: { componentId: 'disc_220_a1', port: 'top' } },
      { from: { componentId: 'disc_220_a1', port: 'bottom' }, to: { componentId: 'bus_220_b', port: 'top' } },

      { from: { componentId: 'bus_220_a', port: 'bottom' }, to: { componentId: 'brk_220_a_sec2', port: 'top' } },
      { from: { componentId: 'brk_220_a_sec2', port: 'bottom' }, to: { componentId: 'disc_220_a2', port: 'top' } },
      { from: { componentId: 'disc_220_a2', port: 'bottom' }, to: { componentId: 'bus_220_b', port: 'top' } },

      { from: { componentId: 'bus_220_b', port: 'top' }, to: { componentId: 'brk_220_b_sec1', port: 'bottom' } },
      { from: { componentId: 'bus_220_b', port: 'top' }, to: { componentId: 'brk_220_b_sec2', port: 'bottom' } },

      { from: { componentId: 'bus_220_a', port: 'bottom' }, to: { componentId: 'brk_220_coupler', port: 'top' } },
      { from: { componentId: 'brk_220_coupler', port: 'bottom' }, to: { componentId: 'bus_220_b', port: 'top' } },

      { from: { componentId: 'bus_220_a', port: 'bottom' }, to: { componentId: 'brk_xfmr1_hv', port: 'top' } },
      { from: { componentId: 'brk_xfmr1_hv', port: 'bottom' }, to: { componentId: 'xfmr1', port: 'top' } },
      { from: { componentId: 'xfmr1', port: 'bottom' }, to: { componentId: 'brk_xfmr1_lv', port: 'top' } },
      { from: { componentId: 'brk_xfmr1_lv', port: 'bottom' }, to: { componentId: 'bus_110_a', port: 'top' } },

      { from: { componentId: 'bus_220_a', port: 'bottom' }, to: { componentId: 'brk_xfmr2_hv', port: 'top' } },
      { from: { componentId: 'brk_xfmr2_hv', port: 'bottom' }, to: { componentId: 'xfmr2', port: 'top' } },
      { from: { componentId: 'xfmr2', port: 'bottom' }, to: { componentId: 'brk_xfmr2_lv', port: 'top' } },
      { from: { componentId: 'brk_xfmr2_lv', port: 'bottom' }, to: { componentId: 'bus_110_a', port: 'top' } },

      { from: { componentId: 'bus_110_a', port: 'bottom' }, to: { componentId: 'disc_110_a1', port: 'top' } },
      { from: { componentId: 'disc_110_a1', port: 'bottom' }, to: { componentId: 'bus_110_b', port: 'top' } },
      { from: { componentId: 'bus_110_a', port: 'bottom' }, to: { componentId: 'disc_110_a2', port: 'top' } },
      { from: { componentId: 'disc_110_a2', port: 'bottom' }, to: { componentId: 'bus_110_b', port: 'top' } },

      { from: { componentId: 'bus_110_a', port: 'bottom' }, to: { componentId: 'brk_110_coupler', port: 'top' } },
      { from: { componentId: 'brk_110_coupler', port: 'bottom' }, to: { componentId: 'bus_110_b', port: 'top' } },

      { from: { componentId: 'bus_110_b', port: 'bottom' }, to: { componentId: 'line_110_1', port: 'top' } },
      { from: { componentId: 'bus_110_b', port: 'bottom' }, to: { componentId: 'line_110_2', port: 'top' } },

      { from: { componentId: 'line_110_1', port: 'bottom' }, to: { componentId: 'gnd_1', port: 'top' } },
      { from: { componentId: 'line_110_2', port: 'bottom' }, to: { componentId: 'gnd_2', port: 'top' } },
    ];

    this.topology.buildGraph(this.components, this.connections);
    this.energizedMap = this.topology.calculate();
  }

  resize(width: number, height: number): void {
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = width * this.dpr;
    this.canvas.height = height * this.dpr;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    this.scaleX = width / this.baseW;
    this.scaleY = height / this.baseH;
  }

  updateBreakerStates(statuses: Record<string, BreakerStatus>): void {
    for (const [id, status] of Object.entries(statuses)) {
      this.pendingBreakerStates[id] = status;
    }
    this.pendingDirty = true;
  }

  swapBuffers(): void {
    if (!this.pendingDirty) return;
    this.pendingDirty = false;
    const updates = this.pendingBreakerStates;
    this.pendingBreakerStates = {};
    let changed = false;
    for (const [id, status] of Object.entries(updates)) {
      const prev = this.breakerStates.get(id);
      if (prev !== status) {
        changed = true;
        this.breakerStates.set(id, status);
        this.topology.updateBreakerState(id, status);
      }
    }
    if (changed) {
      this.energizedMap = this.topology.calculate();
      for (const comp of this.components) {
        comp.energized = this.energizedMap.get(comp.id) ?? false;
      }
    }
  }

  render(): void {
    this.swapBuffers();
    const ctx = this.ctx;
    const w = this.canvas.width / this.dpr;
    const h = this.canvas.height / this.dpr;

    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, w, h);

    this.drawGrid(w, h);

    ctx.save();
    ctx.scale(this.scaleX, this.scaleY);

    this.drawConnections();
    for (const comp of this.components) {
      this.drawComponent(comp);
    }

    ctx.restore();
    this.drawTitle(w);
  }

  private drawGrid(w: number, h: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 0.5;
    const step = 40;
    for (let x = 0; x < w; x += step) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let y = 0; y < h; y += step) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
  }

  private drawTitle(w: number): void {
    const ctx = this.ctx;
    ctx.font = 'bold 14px "Consolas", "Courier New", monospace';
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = 'center';
    ctx.fillText('220kV / 110kV Substation Single Line Diagram', w / 2, 22);
    ctx.textAlign = 'start';
  }

  private drawConnections(): void {
    const ctx = this.ctx;
    for (const conn of this.connections) {
      const fromComp = this.components.find((c) => c.id === conn.from.componentId);
      const toComp = this.components.find((c) => c.id === conn.to.componentId);
      if (!fromComp || !toComp) continue;

      const fromPos = this.getPortPosition(fromComp, conn.from.port);
      const toPos = this.getPortPosition(toComp, conn.to.port);
      if (!fromPos || !toPos) continue;

      const fromEnergized = this.energizedMap.get(fromComp.id) ?? false;
      const toEnergized = this.energizedMap.get(toComp.id) ?? false;
      const energized = fromEnergized || toEnergized;

      ctx.beginPath();
      ctx.strokeStyle = energized ? COLORS.connection : COLORS.connectionDe;
      ctx.lineWidth = energized ? 2.5 : 1.5;
      ctx.lineCap = 'round';

      if (fromPos.x === toPos.x || fromPos.y === toPos.y) {
        ctx.moveTo(fromPos.x, fromPos.y);
        ctx.lineTo(toPos.x, toPos.y);
      } else {
        const midY = (fromPos.y + toPos.y) / 2;
        ctx.moveTo(fromPos.x, fromPos.y);
        ctx.lineTo(fromPos.x, midY);
        ctx.lineTo(toPos.x, midY);
        ctx.lineTo(toPos.x, toPos.y);
      }
      ctx.stroke();
    }
  }

  private getPortPosition(comp: SldComponent, port: string): { x: number; y: number } | null {
    const cx = comp.x + comp.width / 2;
    const cy = comp.y + comp.height / 2;

    switch (port) {
      case 'top':
        return { x: cx, y: comp.y };
      case 'bottom':
        return { x: cx, y: comp.y + comp.height };
      case 'left':
        return { x: comp.x, y: cy };
      case 'right':
        return { x: comp.x + comp.width, y: cy };
      default:
        if (port.endsWith('_t')) return { x: cx, y: comp.y };
        if (port.endsWith('_b')) return { x: cx, y: comp.y + comp.height };
        if (port.endsWith('_l')) return { x: comp.x, y: cy };
        if (port.endsWith('_r')) return { x: comp.x + comp.width, y: cy };
        return null;
    }
  }

  private drawComponent(comp: SldComponent): void {
    switch (comp.type) {
      case 'busbar':
        this.drawBusbar(comp);
        break;
      case 'breaker':
        this.drawBreaker(comp);
        break;
      case 'disconnector':
        this.drawDisconnector(comp);
        break;
      case 'transformer':
        this.drawTransformer(comp);
        break;
      case 'line':
        this.drawLine(comp);
        break;
      case 'ground':
        this.drawGround(comp);
        break;
    }
  }

  private drawBusbar(comp: SldComponent): void {
    const ctx = this.ctx;
    const energized = this.energizedMap.get(comp.id) ?? false;

    ctx.strokeStyle = energized ? COLORS.busbar : COLORS.busbarDe;
    ctx.lineWidth = 8;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(comp.x, comp.y + comp.height / 2);
    ctx.lineTo(comp.x + comp.width, comp.y + comp.height / 2);
    ctx.stroke();

    if (energized) {
      ctx.shadowColor = COLORS.energized;
      ctx.shadowBlur = 10;
      ctx.strokeStyle = COLORS.busbar;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(comp.x, comp.y + comp.height / 2);
      ctx.lineTo(comp.x + comp.width, comp.y + comp.height / 2);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    ctx.font = 'bold 11px "Consolas", monospace';
    ctx.fillStyle = energized ? COLORS.text : COLORS.labelText;
    ctx.textAlign = 'left';
    ctx.fillText(comp.label, comp.x + 4, comp.y - 4);
  }

  private drawBreaker(comp: SldComponent): void {
    const ctx = this.ctx;
    const state = this.breakerStates.get(comp.id) ?? 'open';
    const energized = this.energizedMap.get(comp.id) ?? false;
    const cx = comp.x + comp.width / 2;
    const cy = comp.y + comp.height / 2;
    const halfSize = comp.width / 2;

    let fillColor: string;
    let strokeColor: string;
    switch (state) {
      case 'closed':
        fillColor = 'rgba(0, 255, 136, 0.15)';
        strokeColor = COLORS.breakerClosed;
        break;
      case 'intermediate':
        fillColor = 'rgba(255, 170, 0, 0.15)';
        strokeColor = COLORS.breakerIntermediate;
        break;
      default:
        fillColor = 'rgba(255, 68, 68, 0.1)';
        strokeColor = COLORS.breakerOpen;
        break;
    }

    ctx.fillStyle = fillColor;
    ctx.fillRect(comp.x, comp.y, comp.width, comp.height);

    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 2;
    ctx.strokeRect(comp.x, comp.y, comp.width, comp.height);

    if (state === 'closed') {
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(cx - halfSize * 0.5, cy - halfSize * 0.5);
      ctx.lineTo(cx + halfSize * 0.5, cy + halfSize * 0.5);
      ctx.moveTo(cx + halfSize * 0.5, cy - halfSize * 0.5);
      ctx.lineTo(cx - halfSize * 0.5, cy + halfSize * 0.5);
      ctx.stroke();
    } else if (state === 'open') {
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(cx - halfSize * 0.5, cy);
      ctx.lineTo(cx + halfSize * 0.5, cy);
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(cx, cy - 4, 3, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx - halfSize * 0.4, cy);
      ctx.lineTo(cx + halfSize * 0.4, cy);
      ctx.moveTo(cx, cy - halfSize * 0.4);
      ctx.lineTo(cx, cy + halfSize * 0.4);
      ctx.stroke();
    }

    if (energized) {
      ctx.shadowColor = COLORS.energized;
      ctx.shadowBlur = 6;
      ctx.strokeStyle = 'rgba(0, 255, 136, 0.3)';
      ctx.lineWidth = 1;
      ctx.strokeRect(comp.x - 2, comp.y - 2, comp.width + 4, comp.height + 4);
      ctx.shadowBlur = 0;
    }

    ctx.font = 'bold 10px "Consolas", monospace';
    ctx.fillStyle = COLORS.labelText;
    ctx.textAlign = 'center';
    ctx.fillText(comp.label, cx, comp.y - 4);
  }

  private drawDisconnector(comp: SldComponent): void {
    const ctx = this.ctx;
    const energized = this.energizedMap.get(comp.id) ?? false;
    const cx = comp.x + comp.width / 2;
    const cy = comp.y + comp.height / 2;

    ctx.strokeStyle = energized ? COLORS.energized : COLORS.deEnergized;
    ctx.lineWidth = 2;

    ctx.beginPath();
    ctx.moveTo(cx, comp.y);
    ctx.lineTo(cx, cy - 4);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(cx - 6, cy + 4);
    ctx.lineTo(cx, cy - 4);
    ctx.lineTo(cx + 6, cy + 4);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(cx, cy + 4);
    ctx.lineTo(cx, comp.y + comp.height);
    ctx.stroke();

    ctx.font = '8px "Consolas", monospace';
    ctx.fillStyle = COLORS.labelText;
    ctx.textAlign = 'left';
    ctx.fillText(comp.label, cx + 8, cy + 3);
  }

  private drawTransformer(comp: SldComponent): void {
    const ctx = this.ctx;
    const energized = this.energizedMap.get(comp.id) ?? false;
    const cx = comp.x + comp.width / 2;
    const cy = comp.y + comp.height / 2;
    const r = Math.min(comp.width, comp.height) * 0.32;

    const color = energized ? COLORS.transformer : COLORS.deEnergized;

    ctx.strokeStyle = color;
    ctx.lineWidth = 2;

    ctx.beginPath();
    ctx.arc(cx, cy - r * 0.5, r, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy + r * 0.5, r, 0, Math.PI * 2);
    ctx.stroke();

    if (energized) {
      ctx.shadowColor = COLORS.transformer;
      ctx.shadowBlur = 10;
      ctx.strokeStyle = 'rgba(0, 170, 255, 0.3)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy - r * 0.5, r + 3, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy + r * 0.5, r + 3, 0, Math.PI * 2);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    ctx.font = 'bold 12px "Consolas", monospace';
    ctx.fillStyle = energized ? COLORS.text : COLORS.labelText;
    ctx.textAlign = 'left';
    ctx.fillText(comp.label, cx + r + 8, cy + 4);
  }

  private drawLine(comp: SldComponent): void {
    const ctx = this.ctx;
    const energized = this.energizedMap.get(comp.id) ?? false;
    const cx = comp.x + comp.width / 2;
    const topY = comp.y;
    const bottomY = comp.y + comp.height;

    ctx.strokeStyle = energized ? COLORS.line : COLORS.deEnergized;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, topY);
    ctx.lineTo(cx, bottomY);
    ctx.stroke();

    ctx.fillStyle = energized ? COLORS.line : COLORS.deEnergized;
    if (comp.y < 100) {
      ctx.beginPath();
      ctx.moveTo(cx - 7, topY + 10);
      ctx.lineTo(cx + 7, topY + 10);
      ctx.lineTo(cx, topY);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(cx - 7, bottomY - 10);
      ctx.lineTo(cx + 7, bottomY - 10);
      ctx.lineTo(cx, bottomY);
      ctx.closePath();
      ctx.fill();
    }

    ctx.font = 'bold 10px "Consolas", monospace';
    ctx.fillStyle = energized ? COLORS.text : COLORS.labelText;
    ctx.textAlign = 'left';
    ctx.fillText(comp.label, cx + 10, comp.y + comp.height / 2);
  }

  private drawGround(comp: SldComponent): void {
    const ctx = this.ctx;
    const cx = comp.x + comp.width / 2;
    const cy = comp.y + comp.height / 2;

    ctx.strokeStyle = COLORS.ground;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, comp.y);
    ctx.lineTo(cx, cy);
    ctx.stroke();

    ctx.lineWidth = 1.5;
    const gw = 14;
    for (let i = 0; i < 3; i++) {
      const y = cy + i * 5;
      const w = gw - i * 5;
      ctx.beginPath();
      ctx.moveTo(cx - w / 2, y);
      ctx.lineTo(cx + w / 2, y);
      ctx.stroke();
    }
  }

  getComponents(): SldComponent[] {
    return [...this.components];
  }

  getConnections(): SldConnection[] {
    return [...this.connections];
  }
}

export default SldRenderer;
