import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { createQueryClient } from "./query-client.ts";
import "./styles.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("index.html has no #root element");
}

const queryClient = createQueryClient();

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
