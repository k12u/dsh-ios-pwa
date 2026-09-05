import { createRoot } from "react-dom/client";
import { App } from "./app/App";
createRoot(document.getElementById("root")!).render(<App/>);
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").then(registration => {
      if (registration.waiting) window.dispatchEvent(new Event("app-update"));
      registration.addEventListener("updatefound", () => {
        registration.installing?.addEventListener("statechange", () => {
          if (registration.waiting && navigator.serviceWorker.controller) window.dispatchEvent(new Event("app-update"));
        });
      });
    }).catch(() => { /* App remains usable when installation is unavailable. */ });
  });
}
