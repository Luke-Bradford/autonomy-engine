import { useEffect, useState } from 'react';
import { ReactFlow, Background, Controls, MiniMap, type Node, type Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { Hello } from '@autonomy-studio/shared';
import { useCounterStore } from './store';

const initialNodes: Node[] = [
  { id: '1', position: { x: 0, y: 0 }, data: { label: 'Trigger' } },
  { id: '2', position: { x: 200, y: 100 }, data: { label: 'Activity' } },
];

const initialEdges: Edge[] = [{ id: 'e1-2', source: '1', target: '2' }];

function HelloBanner() {
  const [hello, setHello] = useState<Hello | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/hello')
      .then((res) => {
        if (!res.ok) throw new Error(`request failed: ${res.status}`);
        return res.json() as Promise<Hello>;
      })
      .then((data) => {
        if (!cancelled) setHello(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <p role="alert">Failed to load /api/hello: {error}</p>;
  if (!hello) return <p>Loading /api/hello…</p>;
  return (
    <p>
      {hello.message} <small>(ts: {new Date(hello.ts).toISOString()})</small>
    </p>
  );
}

function Counter() {
  const count = useCounterStore((state) => state.count);
  const increment = useCounterStore((state) => state.increment);
  return (
    <button type="button" onClick={increment}>
      zustand count: {count}
    </button>
  );
}

export default function App() {
  return (
    <main>
      <h1>autonomy-studio</h1>
      <HelloBanner />
      <Counter />
      <div style={{ width: '100%', height: 400 }}>
        <ReactFlow nodes={initialNodes} edges={initialEdges} fitView>
          <Background />
          <Controls />
          <MiniMap />
        </ReactFlow>
      </div>
    </main>
  );
}
