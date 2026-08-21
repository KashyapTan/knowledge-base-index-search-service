import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

function FoundationApp() {
  return (
    <main>
      <p className="eyebrow">Local · private · foundation check</p>
      <h1>Knowledge Base Index Search Service</h1>
      <p>
        The Bun server and compiled React asset pipeline are ready. Search arrives in a later plan.
      </p>
    </main>
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("The UI root element is missing.");

createRoot(rootElement).render(
  <StrictMode>
    <FoundationApp />
  </StrictMode>,
);
