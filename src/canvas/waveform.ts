import type { SvMessage } from '../models/types';

const CHANNEL_COLORS = ['#00ff88', '#44ff44', '#00ddff', '#0099ff'];
const CHANNEL_LABELS = ['Voltage A', 'Voltage B', 'Current A', 'Current B'];
const GRID_COLOR = '#1a2030';
const AXIS_COLOR = '#333355';
const LABEL_COLOR = '#666688';
const BACKGROUND = '#0d1117';
const MAX_VISIBLE_SAMPLES = 200;

interface ChannelData {
  values: number[];
  color: string;
  label: string;
}

class WaveformRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private channels: ChannelData[] = [];
  private dpr: number = 1;
  private yMin: number = -1;
  private yMax: number = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.dpr = window.devicePixelRatio || 1;

    this.channels = CHANNEL_LABELS.map((label, i) => ({
      values: [],
      color: CHANNEL_COLORS[i],
      label,
    }));
  }

  resize(width: number, height: number): void {
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = width * this.dpr;
    this.canvas.height = height * this.dpr;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  addSvData(msg: SvMessage): void {
    const voltA = msg.voltageChannels[0] ?? 0;
    const voltB = msg.voltageChannels[1] ?? 0;
    const currA = msg.currentChannels[0] ?? 0;
    const currB = msg.currentChannels[1] ?? 0;

    const newValues = [voltA, voltB, currA, currB];

    for (let i = 0; i < this.channels.length; i++) {
      this.channels[i].values.push(newValues[i]);
      if (this.channels[i].values.length > MAX_VISIBLE_SAMPLES * 2) {
        this.channels[i].values = this.channels[i].values.slice(-MAX_VISIBLE_SAMPLES);
      }
    }
  }

  render(): void {
    const ctx = this.ctx;
    const w = this.canvas.width / this.dpr;
    const h = this.canvas.height / this.dpr;

    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, w, h);

    const margin = { top: 25, right: 20, bottom: 30, left: 55 };
    const plotW = w - margin.left - margin.right;
    const plotH = h - margin.top - margin.bottom;

    if (plotW <= 0 || plotH <= 0) return;

    this.autoScale();

    this.drawGrid(margin, plotW, plotH);
    this.drawAxes(margin, plotW, plotH);
    this.drawWaveforms(margin, plotW, plotH);
    this.drawLegend(w, margin);
    this.drawTitle(w, margin);
  }

  private autoScale(): void {
    let min = Infinity;
    let max = -Infinity;

    for (const ch of this.channels) {
      const visible = ch.values.slice(-MAX_VISIBLE_SAMPLES);
      for (const v of visible) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }

    if (!isFinite(min) || !isFinite(max)) {
      this.yMin = -1;
      this.yMax = 1;
      return;
    }

    const range = max - min || 1;
    const padding = range * 0.1;
    this.yMin = min - padding;
    this.yMax = max + padding;
  }

  private drawGrid(margin: { top: number; left: number }, plotW: number, plotH: number): void {
    const ctx = this.ctx;

    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth = 0.5;

    const xSteps = 10;
    for (let i = 0; i <= xSteps; i++) {
      const x = margin.left + (plotW * i) / xSteps;
      ctx.beginPath();
      ctx.moveTo(x, margin.top);
      ctx.lineTo(x, margin.top + plotH);
      ctx.stroke();
    }

    const ySteps = 8;
    for (let i = 0; i <= ySteps; i++) {
      const y = margin.top + (plotH * i) / ySteps;
      ctx.beginPath();
      ctx.moveTo(margin.left, y);
      ctx.lineTo(margin.left + plotW, y);
      ctx.stroke();
    }
  }

  private drawAxes(margin: { top: number; left: number; bottom: number }, plotW: number, plotH: number): void {
    const ctx = this.ctx;

    ctx.strokeStyle = AXIS_COLOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(margin.left, margin.top);
    ctx.lineTo(margin.left, margin.top + plotH);
    ctx.lineTo(margin.left + plotW, margin.top + plotH);
    ctx.stroke();

    const ySteps = 8;
    ctx.font = '9px "Consolas", monospace';
    ctx.fillStyle = LABEL_COLOR;
    ctx.textAlign = 'right';

    for (let i = 0; i <= ySteps; i++) {
      const y = margin.top + (plotH * i) / ySteps;
      const value = this.yMax - ((this.yMax - this.yMin) * i) / ySteps;
      ctx.fillText(value.toFixed(2), margin.left - 5, y + 3);
    }

    ctx.textAlign = 'center';
    const xSteps = 10;
    for (let i = 0; i <= xSteps; i++) {
      const x = margin.left + (plotW * i) / xSteps;
      const sampleIdx = Math.round((MAX_VISIBLE_SAMPLES * i) / xSteps);
      ctx.fillText(String(sampleIdx), x, margin.top + plotH + 15);
    }
  }

  private drawWaveforms(margin: { top: number; left: number }, plotW: number, plotH: number): void {
    const ctx = this.ctx;

    for (const ch of this.channels) {
      const visible = ch.values.slice(-MAX_VISIBLE_SAMPLES);
      if (visible.length < 2) continue;

      ctx.strokeStyle = ch.color;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      ctx.beginPath();
      const range = this.yMax - this.yMin || 1;

      for (let i = 0; i < visible.length; i++) {
        const x = margin.left + (plotW * i) / (MAX_VISIBLE_SAMPLES - 1);
        const normalized = (visible[i] - this.yMin) / range;
        const y = margin.top + plotH - normalized * plotH;

        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }
  }

  private drawLegend(w: number, margin: { top: number }): void {
    const ctx = this.ctx;
    ctx.font = '9px "Consolas", monospace';
    const legendY = margin.top - 8;
    let x = 60;

    for (let i = 0; i < this.channels.length; i++) {
      ctx.fillStyle = this.channels[i].color;
      ctx.fillRect(x, legendY - 6, 12, 3);
      ctx.fillStyle = LABEL_COLOR;
      ctx.textAlign = 'left';
      ctx.fillText(this.channels[i].label, x + 16, legendY);
      x += ctx.measureText(this.channels[i].label).width + 30;
    }
  }

  private drawTitle(w: number, margin: { top: number }): void {
    const ctx = this.ctx;
    ctx.font = 'bold 11px "Consolas", monospace';
    ctx.fillStyle = '#aaaacc';
    ctx.textAlign = 'right';
    ctx.fillText('SV Waveform Monitor', w - 15, margin.top - 8);
    ctx.textAlign = 'start';
  }
}

export default WaveformRenderer;
