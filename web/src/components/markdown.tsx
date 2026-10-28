import { lazy, Suspense } from 'react';

// react-markdown is ~35 KB gzipped: loaded the first time some text is rendered, not with the page.
const Impl = lazy(() => import('./md-impl'));
export const Md = ({ children, animate }: { children: string; /** float new words in (agent text that arrives while the page is open) */ animate?: boolean }) => <Suspense fallback={null}><Impl animate={animate}>{children}</Impl></Suspense>;
