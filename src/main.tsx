import React from "react";
import ReactDOM from "react-dom/client";
import App, { SamplesGallery } from "./App";
import "./index.css";

const showSamples = new URLSearchParams(window.location.search).has("samples");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{showSamples ? <SamplesGallery /> : <App />}</React.StrictMode>,
);
