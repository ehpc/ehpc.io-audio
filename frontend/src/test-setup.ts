import "@testing-library/jest-dom/vitest";
import { cleanup } from "@solidjs/testing-library";
import { afterEach } from "vitest";

// JSDOM does not implement element scrolling.
Element.prototype.scrollTo = function (options: ScrollToOptions | number, y?: number) {
  if (typeof options === "number") { this.scrollLeft = options; this.scrollTop = y ?? 0; }
  else { if (options.left !== undefined) this.scrollLeft = options.left; if (options.top !== undefined) this.scrollTop = options.top; }
};

afterEach(cleanup);
