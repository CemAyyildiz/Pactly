import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router";

import { App } from "./App";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/editorial.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element #root not found in index.html");
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A 404 (unapproved/unknown provider, not-a-provider) will not
      // resolve itself by retrying -- see each hook's own `retry: false`.
      // The default here only covers queries that do not set it
      // explicitly (none yet, but kept conservative for what comes next).
      retry: 1,
    },
  },
});

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
