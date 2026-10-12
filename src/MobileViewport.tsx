import { useEffect } from 'react';

// Safari and Android can resize the visible viewport without resizing the layout viewport.
export function MobileViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    const touch = window.matchMedia('(pointer: coarse)');
    const root = document.documentElement;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!touch.matches || !viewport) {
          root.style.removeProperty('--mobile-viewport-height');
          root.style.removeProperty('--mobile-viewport-top');
          return;
        }
        // Browsers may override the zoom restriction; avoid reflowing during that zoom.
        if (Math.abs(viewport.scale - 1) > 0.01) return;
        root.style.setProperty('--mobile-viewport-height', `${viewport.height}px`);
        root.style.setProperty('--mobile-viewport-top', `${viewport.offsetTop}px`);
      });
    };
    const preventGesture = (event: Event) => {
      if (touch.matches && event.cancelable) event.preventDefault();
    };
    const preventPinch = (event: TouchEvent) => {
      if (touch.matches && event.touches.length > 1 && event.cancelable) event.preventDefault();
    };
    update();
    // iOS Safari can ignore user-scalable=no, so also suppress its pinch gestures.
    document.addEventListener('gesturestart', preventGesture, { passive: false });
    document.addEventListener('gesturechange', preventGesture, { passive: false });
    document.addEventListener('touchmove', preventPinch, { passive: false });
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    touch.addEventListener('change', update);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('gesturestart', preventGesture);
      document.removeEventListener('gesturechange', preventGesture);
      document.removeEventListener('touchmove', preventPinch);
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      touch.removeEventListener('change', update);
      root.style.removeProperty('--mobile-viewport-height');
      root.style.removeProperty('--mobile-viewport-top');
    };
  }, []);
  return null;
}
