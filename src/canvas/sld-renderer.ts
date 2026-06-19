import type { SldComponent, SldConnection, BreakerStatus } from '../models/types';
import TopologyEngine, { type IslandInfo, type TopologyAnalysis } from './topology';

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

  islandPrimary: '#ff6b35',
  islandSecondary: '#ff3366',
  islandGlow: 'rgba(255, 107, 53, 0.7)',
  islandBorder: '#ff8844',
  islandBg: 'rgba(255, 100, 50, 0.08)',
  groundedWarn: '#ffdd33',
};

const ISLAND_BLINK_PERIOD = 900;
const ISLAND_BLINK_DUTY = 0.5;

type ShaderKind = 'energized' | 'island' | 'grounded' | 'dead';

interface CompShader {
  kind: ShaderKind;
  islandId: number;
  primary: string;
  glow: string;
  bgFill: string;
  pulseAlpha: number;
  blinkOn: boolean;
  borderWidth: number;
}

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
  private islandMap: Map<string, number> = new Map();
  private islandsById: Map<number, IslandInfo> = new Map();
  private lastAnalysis: TopologyAnalysis | null = null;
  private animStart: number = performance.now();
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
    this.recomputeTopology(true);
  }

  private recomputeTopology(force: boolean = false): void {
    const analysis = this.topology.analyze();
    this.energizedMap = analysis.energizedMap;
    this.islandMap = analysis.islandMap;
    this.islandsById = new Map(analysis.islands.map((i) => [i.id, i]));
    this.lastAnalysis = analysis;

    if (force) {
      for (const comp of this.components) {
        comp.energized = this.energizedMap.get(comp.id) ?? false;
      }
    } else {
      for (const comp of this.components) {
        comp.energized = this.energizedMap.get(comp.id) ?? false;
      }
    }
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
      this.recomputeTopology(false);
    }
  }

  private computeShader(compId: string): CompShader {
    const now = performance.now() - this.animStart;
    const islandId = this.islandMap.get(compId);
    const energized = this.energizedMap.get(compId) ?? false;
    const island = islandId ? this.islandsById.get(islandId) : null;

    let kind: ShaderKind = 'dead';
    if (energized) kind = 'energized';
    else if (island && island.type === 'island') kind = 'island';
    else if (island && island.type === 'grounded') kind = 'grounded';
    else if (island && island.hasSource) kind = 'energized';
    else kind = 'dead';

    const phase = ((now / ISLAND_BLINK_PERIOD) % 1 + (islandId ?? 0) * 0.23) % 1;
    const blinkOn = phase < ISLAND_BLINK_DUTY;
    const smooth = 0.5 - 0.5 * Math.cos((now / (ISLAND_BLINK_PERIOD / 2)) * Math.PI * 2);
    const pulseAlpha = 0.2 + smooth * 0.8;

    let primary = COLORS.deEnergized;
    let glow = 'rgba(0,0,0,0)';
    let bgFill = 'rgba(0,0,0,0)';
    let borderWidth = 2;

    switch (kind) {
      case 'energized':
        primary = COLORS.energized;
        glow = 'rgba(0, 255, 136, 0.65)';
        bgFill = 'rgba(0, 255, 136, 0.03)';
        borderWidth = 2;
        break;
      case 'island':
        primary = blinkOn ? COLORS.islandPrimary : COLORS.islandSecondary;
        glow = COLORS.islandGlow;
        bgFill = COLORS.islandBg;
        borderWidth = 3 + (blinkOn ? 2 : 0);
        break;
      case 'grounded':
        primary = COLORS.groundedWarn;
        glow = 'rgba(255, 221, 51, 0.5)';
        bgFill = 'rgba(255, 221, 51, 0.06)';
        borderWidth = 2 + (blinkOn ? 1 : 0);
        break;
      case 'dead':
        primary = COLORS.deEnergized;
        glow = 'rgba(0,0,0,0)';
        bgFill = 'rgba(0,0,0,0)';
        borderWidth = 1.5;
        break;
    }

    return {
      kind,
      islandId: islandId ?? 0,
      primary,
      glow,
      bgFill,
      pulseAlpha,
      blinkOn,
      borderWidth,
    };
  }

  render(): void {
    this.swapBuffers();
    const ctx = this.ctx;
    const w = this.canvas.width / this.dpr;
    const h = this.canvas.height / this.dpr;

    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, w, h);

    this.drawGrid(w, h);
    this.drawIslandsDiagnostic(w, h);

    ctx.save();
    ctx.scale(this.scaleX, this.scaleY);

    this.drawIslandOverlays();
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

  private drawIslandsDiagnostic(w: number, h: number): void {
    if (!this.lastAnalysis) return;
    const analysis = this.lastAnalysis;
    const activeIslands = analysis.islands.filter((i) => i.type === 'island' || i.type === 'grounded');

    const ctx = this.ctx;
    ctx.save();
    let y = h - 16;
    ctx.font = '10px "Consolas", monospace';
    ctx.textAlign = 'right';

    if (activeIslands.length > 0) {
      const now = performance.now() - this.animStart;
      const blink = Math.sin(now / 200) > 0;
      ctx.fillStyle = blink ? COLORS.islandPrimary : COLORS.islandSecondary;
      ctx.font = 'bold 10px "Consolas", monospace';
      const labels: string[] = [];
      for (const il of activeIslands) {
        const members = il.memberIds
          .filter((m) => m.startsWith('bus_') || m.startsWith('line_') || m.startsWith('xfmr'))
          .map((m) => {
            const c = this.components.find((cc) => cc.id === m);
            return c?.label || m;
          })
          .filter(Boolean)
          .slice(0, 3);
        labels.push(`孤岛#${il.id}(${il.type}:${il.size}件→${members.join(',')})`);
      }
      ctx.fillText(`⚠ ${activeIslands.length} 处供电孤岛：${labels.join(' | ')}  ←`, w - 16, y);
    } else {
      ctx.fillStyle = '#556677';
      ctx.fillText('✓ 拓扑分析：0 孤岛, 220kV 双电源正常', w - 16, y);
    }

    ctx.textAlign = 'left';
    ctx.fillStyle = '#556677';
    ctx.fillText(`电源点:${analysis.sourceCount}  孤岛设备:${analysis.isolatedCount}  连通区域:${analysis.islands.length + 1}`, 16, y);

    ctx.restore();
  }

  private drawIslandOverlays(): void {
    if (!this.lastAnalysis) return;
    const activeIslands = this.lastAnalysis.islands.filter(
      (i) => i.type === 'island' || i.type === 'grounded',
    );
    if (activeIslands.length === 0) return;

    const ctx = this.ctx;
    for (const il of activeIslands) {
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      let count = 0;
      for (const mid of il.memberIds) {
        const comp = this.components.find((c) => c.id === mid);
        if (!comp) continue;
        count++;
        minX = Math.min(minX, comp.x);
        minY = Math.min(minY, comp.y);
        maxX = Math.max(maxX, comp.x + comp.width);
        maxY = Math.max(maxY, comp.y + comp.height);
      }
      if (count === 0) continue;
      const now = performance.now() - this.animStart;
      const smooth = 0.5 - 0.5 * Math.cos((now / (ISLAND_BLINK_PERIOD / 2)) * Math.PI * 2);
      const pad = 10 + smooth * 8;
      minX -= pad;
      minY -= pad;
      maxX += pad;
      maxY += pad;

      ctx.save();
      const color = il.type === 'grounded' ? COLORS.groundedWarn : COLORS.islandPrimary;
      ctx.shadowColor = color;
      ctx.shadowBlur = 20 + smooth * 25;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2 + smooth * 2;
      ctx.setLineDash([8, 4]);
      ctx.lineDashOffset = -now / 60;
      ctx.globalAlpha = 0.45 + smooth * 0.45;
      const r = 14;
      this.roundRect(minX, minY, maxX - minX, maxY - minY, r);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.globalAlpha = 0.08 + smooth * 0.08;
      ctx.fillStyle = color;
      this.roundRect(minX, minY, maxX - minX, maxY - minY, r);
      ctx.fill();
      ctx.shadowBlur = 0;

      ctx.globalAlpha = 1;
      ctx.font = 'bold 10px "Consolas", monospace';
      ctx.fillStyle = color;
      const tag = `▼ 孤岛#${il.id} · ${il.size} 设备${il.type === 'grounded' ? ' · 含接地' : ''}`;
      ctx.fillText(tag, minX + 8, minY - 4);
      ctx.restore();
    }
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number): void {
    const ctx = this.ctx;
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
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

      const fromShader = this.computeShader(fromComp.id);
      const toShader = this.computeShader(toComp.id);

      const shader: CompShader =
        fromShader.kind !== 'dead' ? fromShader : toShader;
      const energized = shader.kind === 'energized';
      const isIsland = shader.kind === 'island' || shader.kind === 'grounded';

      ctx.beginPath();
      if (isIsland) {
        ctx.strokeStyle = shader.primary;
        ctx.lineWidth = 2.5;
        ctx.shadowColor = shader.glow;
        ctx.shadowBlur = 8 * shader.pulseAlpha;
      } else {
        ctx.strokeStyle = energized ? COLORS.connection : COLORS.connectionDe;
        ctx.lineWidth = energized ? 2.5 : 1.5;
        ctx.shadowBlur = 0;
      }
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
      ctx.shadowBlur = 0;
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

  private hexToRgb(hex: string): [number, number, number] | null {
    const m = hex.replace('#', '').match(/.{2}/g);
    if (!m) return null;
    return m.map((x) => parseInt(x, 16)) as [number, number, number];
  }

  private drawBusbar(comp: SldComponent): void {
    const ctx = this.ctx;
    const shader = this.computeShader(comp.id);
    const rgb = this.hexToRgb(shader.primary);

    ctx.strokeStyle = shader.primary;
    ctx.lineWidth = shader.kind === 'island' || shader.kind === 'grounded' ? 10 : 8;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(comp.x, comp.y + comp.height / 2);
    ctx.lineTo(comp.x + comp.width, comp.y + comp.height / 2);
    ctx.stroke();

    if (shader.kind === 'energized' || shader.kind === 'island' || shader.kind === 'grounded') {
      ctx.shadowColor = shader.glow;
      ctx.shadowBlur = shader.kind === 'energized' ? 10 : 16 * shader.pulseAlpha;
      ctx.strokeStyle = shader.primary;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(comp.x, comp.y + comp.height / 2);
      ctx.lineTo(comp.x + comp.width, comp.y + comp.height / 2);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    if (shader.kind === 'island' || shader.kind === 'grounded') {
      ctx.font = 'bold 9px "Consolas", monospace';
      ctx.fillStyle = shader.primary;
      ctx.textAlign = 'right';
      ctx.fillText(
        shader.kind === 'grounded' ? '⚠ [接地孤岛]' : `⚠ [供电孤岛 #${shader.islandId}]`,
        comp.x + comp.width - 4,
        comp.y - 6,
      );
      ctx.textAlign = 'start';
    }

    ctx.font = 'bold 11px "Consolas", monospace';
    ctx.fillStyle = shader.kind === 'dead' ? COLORS.labelText : COLORS.text;
    ctx.textAlign = 'left';
    ctx.fillText(comp.label, comp.x + 4, comp.y - 4);
    void rgb;
  }

  private drawBreaker(comp: SldComponent): void {
    const ctx = this.ctx;
    const state = this.breakerStates.get(comp.id) ?? 'open';
    const shader = this.computeShader(comp.id);
    const cx = comp.x + comp.width / 2;
    const cy = comp.y + comp.height / 2;
    const halfSize = comp.width / 2;

    let strokeColor: string;
    switch (state) {
      case 'closed':
        strokeColor = shader.kind === 'island' || shader.kind === 'grounded' ? shader.primary : COLORS.breakerClosed;
        break;
      case 'intermediate':
        strokeColor = COLORS.breakerIntermediate;
        break;
      default:
        strokeColor = COLORS.breakerOpen;
        break;
    }

    const alpha = shader.kind === 'island' ? shader.pulseAlpha : 1;
    ctx.save();
    ctx.globalAlpha = 0.9;
    if (shader.kind === 'island' || shader.kind === 'grounded') {
      ctx.fillStyle = shader.bgFill;
    } else if (state === 'closed') {
      ctx.fillStyle = 'rgba(0, 255, 136, 0.15)';
    } else if (state === 'intermediate') {
      ctx.fillStyle = 'rgba(255, 170, 0, 0.15)';
    } else {
      ctx.fillStyle = 'rgba(255, 68, 68, 0.1)';
    }
    ctx.fillRect(comp.x, comp.y, comp.width, comp.height);

    if (shader.kind === 'island' || shader.kind === 'grounded') {
      ctx.shadowColor = shader.glow;
      ctx.shadowBlur = 10 * alpha;
    }
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = shader.borderWidth;
    ctx.strokeRect(comp.x, comp.y, comp.width, comp.height);
    ctx.shadowBlur = 0;

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

    if (shader.kind === 'energized') {
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
    ctx.restore();
    void alpha;
  }

  private drawDisconnector(comp: SldComponent): void {
    const ctx = this.ctx;
    const shader = this.computeShader(comp.id);
    const cx = comp.x + comp.width / 2;
    const cy = comp.y + comp.height / 2;

    const isIsland = shader.kind === 'island' || shader.kind === 'grounded';
    if (isIsland) {
      ctx.shadowColor = shader.glow;
      ctx.shadowBlur = 10 * shader.pulseAlpha;
    }
    ctx.strokeStyle = shader.kind === 'dead' ? COLORS.deEnergized : shader.primary;
    ctx.lineWidth = isIsland ? 3 : 2;

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
    ctx.shadowBlur = 0;

    ctx.font = '8px "Consolas", monospace';
    ctx.fillStyle = COLORS.labelText;
    ctx.textAlign = 'left';
    ctx.fillText(comp.label, cx + 8, cy + 3);
  }

  private drawTransformer(comp: SldComponent): void {
    const ctx = this.ctx;
    const shader = this.computeShader(comp.id);
    const cx = comp.x + comp.width / 2;
    const cy = comp.y + comp.height / 2;
    const r = Math.min(comp.width, comp.height) * 0.32;

    const isIsland = shader.kind === 'island' || shader.kind === 'grounded';
    const color = shader.kind === 'dead' ? COLORS.deEnergized : shader.primary;

    if (isIsland) {
      ctx.shadowColor = shader.glow;
      ctx.shadowBlur = 16 * shader.pulseAlpha;
    } else if (shader.kind === 'energized') {
      ctx.shadowColor = COLORS.transformer;
      ctx.shadowBlur = 10;
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = isIsland ? 3 : 2;

    ctx.beginPath();
    ctx.arc(cx, cy - r * 0.5, r, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy + r * 0.5, r, 0, Math.PI * 2);
    ctx.stroke();

    if (shader.kind !== 'dead') {
      ctx.strokeStyle = shader.kind === 'energized' ? 'rgba(0, 170, 255, 0.3)' : `rgba(255, 120, 60, ${0.3 + 0.3 * shader.pulseAlpha})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy - r * 0.5, r + 3, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy + r * 0.5, r + 3, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.shadowBlur = 0;

    ctx.font = 'bold 12px "Consolas", monospace';
    ctx.fillStyle = shader.kind === 'dead' ? COLORS.labelText : COLORS.text;
    ctx.textAlign = 'left';
    ctx.fillText(comp.label, cx + r + 8, cy + 4);
  }

  private drawLine(comp: SldComponent): void {
    const ctx = this.ctx;
    const shader = this.computeShader(comp.id);
    const cx = comp.x + comp.width / 2;
    const topY = comp.y;
    const bottomY = comp.y + comp.height;

    const isIsland = shader.kind === 'island' || shader.kind === 'grounded';
    const color = shader.kind === 'dead' ? COLORS.deEnergized : shader.primary;

    if (isIsland) {
      ctx.shadowColor = shader.glow;
      ctx.shadowBlur = 10 * shader.pulseAlpha;
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = isIsland ? 3 : 2;
    ctx.beginPath();
    ctx.moveTo(cx, topY);
    ctx.lineTo(cx, bottomY);
    ctx.stroke();

    ctx.fillStyle = color;
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
    ctx.shadowBlur = 0;

    ctx.font = 'bold 10px "Consolas", monospace';
    ctx.fillStyle = shader.kind === 'dead' ? COLORS.labelText : COLORS.text;
    ctx.textAlign = 'left';
    ctx.fillText(comp.label, cx + 10, comp.y + comp.height / 2);
  }

  private drawGround(comp: SldComponent): void {
    const ctx = this.ctx;
    const shader = this.computeShader(comp.id);
    const cx = comp.x + comp.width / 2;
    const cy = comp.y + comp.height / 2;

    ctx.strokeStyle = shader.kind === 'grounded' || shader.kind === 'island' ? shader.primary : COLORS.ground;
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

  getLastAnalysis(): ReturnType<TopologyEngine['analyze']> | null {
    return this.lastAnalysis;
  }

  getTopologyEngine(): TopologyEngine {
    return this.topology;
  }
}

export default SldRenderer;
