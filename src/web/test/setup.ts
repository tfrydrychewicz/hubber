import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// React Testing Library only registers its own cleanup when afterEach is a
// global, and this project keeps Vitest globals off.
afterEach(() => {
  cleanup();
});
