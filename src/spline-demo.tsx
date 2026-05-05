import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SplineSceneBasic } from "@/components/ui/demo";
import "@/index.css";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error('Missing #root element');
}

createRoot(rootEl).render(
  <StrictMode>
    <div className="min-h-screen bg-neutral-950 p-8 text-foreground">
      <div className="mx-auto max-w-5xl">
        <SplineSceneBasic />
      </div>
    </div>
  </StrictMode>,
);
