'use client';

import dynamic from 'next/dynamic';

const Whiteboard = dynamic(() => import('./editor'), {
  ssr: false,
  loading: () => <main className="muze-loading" aria-label="Opening your whiteboard"><span>Muze</span><i/></main>,
});

export function MuzeWorkspace() {
  return <Whiteboard/>;
}
