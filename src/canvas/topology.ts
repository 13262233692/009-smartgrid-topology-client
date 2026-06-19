import type { SldComponent, SldConnection, BreakerStatus } from '../models/types';

export interface IslandInfo {
  id: number;
  memberIds: string[];
  hasSource: boolean;
  size: number;
  type: 'energized' | 'island' | 'grounded';
}

export interface TopologyAnalysis {
  energizedMap: Map<string, boolean>;
  islandMap: Map<string, number>;
  islands: IslandInfo[];
  isolatedCount: number;
  sourceCount: number;
}

interface TopologyGraphNode {
  componentId: string;
  type: string;
  neighbors: Set<string>;
  isSource: boolean;
}

const SOURCE_COMPONENT_PREFIXES = ['line_220_'];

class TopologyEngine {
  private graph: Map<string, TopologyGraphNode> = new Map();
  private components: Map<string, SldComponent> = new Map();
  private connections: SldConnection[] = [];
  private breakerStates: Map<string, BreakerStatus> = new Map();
  private energizedMap: Map<string, boolean> = new Map();
  private islandMap: Map<string, number> = new Map();
  private islands: IslandInfo[] = [];
  private lastAnalysis: TopologyAnalysis | null = null;

  buildGraph(components: SldComponent[], connections: SldConnection[]): void {
    this.components.clear();
    this.graph.clear();
    this.connections = connections;

    for (const comp of components) {
      const isSource =
        comp.type === 'line' && SOURCE_COMPONENT_PREFIXES.some((p) => comp.id.startsWith(p));

      this.components.set(comp.id, comp);
      this.graph.set(comp.id, {
        componentId: comp.id,
        type: comp.type,
        neighbors: new Set(),
        isSource,
      });
    }

    for (const conn of connections) {
      const fromNode = this.graph.get(conn.from.componentId);
      const toNode = this.graph.get(conn.to.componentId);
      if (fromNode && toNode) {
        fromNode.neighbors.add(conn.to.componentId);
        toNode.neighbors.add(conn.from.componentId);
      }
    }
  }

  updateBreakerState(breakerId: string, status: BreakerStatus): void {
    this.breakerStates.set(breakerId, status);
  }

  updateBreakerStates(statuses: Record<string, BreakerStatus>): void {
    for (const [id, status] of Object.entries(statuses)) {
      this.breakerStates.set(id, status);
    }
  }

  private isEdgeBlocked(nodeA: TopologyGraphNode, nodeB: TopologyGraphNode): boolean {
    const check = (n: TopologyGraphNode) => {
      if (n.type === 'breaker') {
        const s = this.breakerStates.get(n.componentId) ?? 'open';
        return s !== 'closed';
      }
      if (n.type === 'disconnector') {
        const s = this.breakerStates.get(n.componentId) ?? 'closed';
        return s === 'open' || s === 'invalid';
      }
      return false;
    };
    return check(nodeA) || check(nodeB);
  }

  calculate(): Map<string, boolean> {
    this.analyze();
    return this.energizedMap;
  }

  analyze(): TopologyAnalysis {
    this.energizedMap.clear();
    this.islandMap.clear();
    this.islands = [];

    for (const [id] of this.graph) {
      this.energizedMap.set(id, false);
    }

    const allVisited = new Set<string>();
    const sources: string[] = [];
    let sourceCount = 0;
    let componentIdx = 0;

    for (const [id, node] of this.graph) {
      if (node.isSource) {
        sources.push(id);
        sourceCount++;
      }
    }

    for (const sourceId of sources) {
      if (allVisited.has(sourceId)) continue;
      this.bfsEnergized(sourceId, allVisited);
    }

    for (const [id, node] of this.graph) {
      if (allVisited.has(id)) continue;
      const compMembers: string[] = [];
      const compHasSource = node.isSource;
      this.bfsComponent(id, allVisited, compMembers);

      componentIdx++;
      const islandId = componentIdx;

      let hasSourceNode = compHasSource;
      for (const mid of compMembers) {
        const n = this.graph.get(mid);
        if (n?.isSource) hasSourceNode = true;
        this.islandMap.set(mid, islandId);
      }

      const hasGround = compMembers.some((mid) => {
        const comp = this.components.get(mid);
        return comp?.type === 'ground';
      });

      const island: IslandInfo = {
        id: islandId,
        memberIds: compMembers.slice().sort(),
        hasSource: hasSourceNode,
        size: compMembers.length,
        type: hasSourceNode ? 'energized' : hasGround ? 'grounded' : 'island',
      };
      this.islands.push(island);
    }

    const energizedIslands = this.islands.filter((i) => i.hasSource).length;
    const isolatedIslands = this.islands.filter((i) => !i.hasSource);
    let isolatedCount = 0;
    for (const i of isolatedIslands) {
      isolatedCount += i.size;
    }

    const analysis: TopologyAnalysis = {
      energizedMap: new Map(this.energizedMap),
      islandMap: new Map(this.islandMap),
      islands: JSON.parse(JSON.stringify(this.islands)),
      isolatedCount,
      sourceCount,
    };
    this.lastAnalysis = analysis;
    return analysis;
  }

  private bfsEnergized(startId: string, globalVisited: Set<string>): void {
    const queue: string[] = [startId];
    const visited = new Set<string>();

    visited.add(startId);
    globalVisited.add(startId);
    this.energizedMap.set(startId, true);

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const currentNode = this.graph.get(currentId);
      if (!currentNode) continue;

      for (const neighborId of currentNode.neighbors) {
        if (visited.has(neighborId)) continue;
        if (globalVisited.has(neighborId)) continue;

        const neighborNode = this.graph.get(neighborId);
        if (!neighborNode) continue;

        if (this.isEdgeBlocked(currentNode, neighborNode)) {
          continue;
        }

        visited.add(neighborId);
        globalVisited.add(neighborId);
        this.energizedMap.set(neighborId, true);
        queue.push(neighborId);
      }
    }
  }

  private bfsComponent(
    startId: string,
    globalVisited: Set<string>,
    membersOut: string[],
  ): void {
    const queue: string[] = [startId];
    const visited = new Set<string>();

    visited.add(startId);
    globalVisited.add(startId);
    membersOut.push(startId);

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const currentNode = this.graph.get(currentId);
      if (!currentNode) continue;

      for (const neighborId of currentNode.neighbors) {
        if (visited.has(neighborId)) continue;
        if (globalVisited.has(neighborId)) continue;

        const neighborNode = this.graph.get(neighborId);
        if (!neighborNode) continue;

        if (this.isEdgeBlocked(currentNode, neighborNode)) {
          continue;
        }

        visited.add(neighborId);
        globalVisited.add(neighborId);
        membersOut.push(neighborId);
        queue.push(neighborId);
      }
    }
  }

  isEnergized(componentId: string): boolean {
    return this.energizedMap.get(componentId) ?? false;
  }

  getEnergizedMap(): Map<string, boolean> {
    return new Map(this.energizedMap);
  }

  getIsland(componentId: string): IslandInfo | null {
    const id = this.islandMap.get(componentId);
    if (!id) return null;
    return this.islands.find((i) => i.id === id) ?? null;
  }

  getLastAnalysis(): TopologyAnalysis | null {
    return this.lastAnalysis;
  }

  getIslandCount(): number {
    return this.islands.filter((i) => !i.hasSource).length;
  }

  getAllIslands(): IslandInfo[] {
    return JSON.parse(JSON.stringify(this.islands));
  }
}

export default TopologyEngine;
