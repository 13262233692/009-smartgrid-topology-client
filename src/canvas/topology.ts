import type { SldComponent, SldConnection, BreakerStatus } from '../models/types';

interface TopologyGraphNode {
  componentId: string;
  type: string;
  neighbors: Set<string>;
  isSource: boolean;
}

class TopologyEngine {
  private graph: Map<string, TopologyGraphNode> = new Map();
  private components: Map<string, SldComponent> = new Map();
  private connections: SldConnection[] = [];
  private breakerStates: Map<string, BreakerStatus> = new Map();
  private energizedMap: Map<string, boolean> = new Map();

  buildGraph(components: SldComponent[], connections: SldConnection[]): void {
    this.components.clear();
    this.graph.clear();
    this.connections = connections;

    for (const comp of components) {
      this.components.set(comp.id, comp);
      this.graph.set(comp.id, {
        componentId: comp.id,
        type: comp.type,
        neighbors: new Set(),
        isSource: comp.type === 'busbar',
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

  calculate(): Map<string, boolean> {
    this.energizedMap.clear();

    for (const [id] of this.graph) {
      this.energizedMap.set(id, false);
    }

    const visited = new Set<string>();
    const sources: string[] = [];

    for (const [id, node] of this.graph) {
      if (node.isSource) {
        sources.push(id);
      }
    }

    for (const sourceId of sources) {
      this.bfs(sourceId, visited);
    }

    return new Map(this.energizedMap);
  }

  private bfs(startId: string, globalVisited: Set<string>): void {
    const queue: string[] = [startId];
    const visited = new Set<string>();

    visited.add(startId);
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

        if (neighborNode.type === 'breaker') {
          const breakerState = this.breakerStates.get(neighborId) ?? 'open';
          if (breakerState !== 'closed') {
            visited.add(neighborId);
            this.energizedMap.set(neighborId, false);
            continue;
          }
        }

        visited.add(neighborId);
        this.energizedMap.set(neighborId, true);
        queue.push(neighborId);
      }
    }

    for (const id of visited) {
      globalVisited.add(id);
    }
  }

  isEnergized(componentId: string): boolean {
    return this.energizedMap.get(componentId) ?? false;
  }

  getEnergizedMap(): Map<string, boolean> {
    return new Map(this.energizedMap);
  }
}

export default TopologyEngine;
