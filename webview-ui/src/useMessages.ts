import { useEffect } from 'react';

/** Subscribes to messages posted by the extension host */
export function useMessages<T>(handler: (message: T) => void): void {
  useEffect(() => {
    const listener = (event: MessageEvent<T>) => handler(event.data);
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, [handler]);
}
