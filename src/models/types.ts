export type BreakerStatus = 'open' | 'closed' | 'intermediate' | 'invalid';

export interface GooseMessage {
  goId: string;
  gocbRef: string;
  stNum: number;
  sqNum: number;
  timestamp: number;
  datasetRef: string;
  breakerStatuses: Record<string, BreakerStatus>;
}

export interface SvMessage {
  smpCnt: number;
  smpMod: number;
  smpRate: number;
  voltageChannels: number[];
  currentChannels: number[];
  timestamp: number;
}

export type SubstationEvent =
  | ({ type: 'goose' } & GooseMessage)
  | ({ type: 'sv' } & SvMessage);

export type SldComponentType =
  | 'busbar'
  | 'breaker'
  | 'disconnector'
  | 'transformer'
  | 'line'
  | 'ground'
  | 'voltage_transformer'
  | 'current_transformer';

export interface SldComponent {
  id: string;
  type: SldComponentType;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  energized: boolean;
  ports: {
    top?: string;
    bottom?: string;
    left?: string;
    right?: string;
  };
}

export interface SldConnection {
  from: { componentId: string; port: string };
  to: { componentId: string; port: string };
}

export interface TopologyNode {
  componentId: string;
  energized: boolean;
  neighbors: string[];
}

export interface ConnectionStatus {
  connected: boolean;
  url: string;
  reconnectAttempt: number;
  lastConnected: number | null;
}

export interface MessageStatistics {
  gooseCount: number;
  svCount: number;
  lastGooseTimestamp: number | null;
  lastSvTimestamp: number | null;
}
