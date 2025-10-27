import "@testing-library/jest-dom";

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

if (typeof globalThis.ResizeObserver === "undefined") {
  Object.defineProperty(globalThis, "ResizeObserver", {
    value: MockResizeObserver,
    writable: true,
  });
}

const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;

Object.defineProperty(Element.prototype, "getBoundingClientRect", {
  configurable: true,
  writable: true,
  value: function getBoundingClientRect(): DOMRect {
    const rect = originalGetBoundingClientRect.call(this);
    if (rect.width === 0 && rect.height === 0) {
      return new DOMRect(0, 0, 800, 400);
    }
    return rect;
  },
});

Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
  configurable: true,
  get() {
    return 800;
  },
});

Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  get() {
    return 400;
  },
});
