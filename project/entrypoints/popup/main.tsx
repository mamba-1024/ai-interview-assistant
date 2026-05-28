import React from "react";
import { createRoot } from "react-dom/client";
import { PopupApp } from "./PopupApp";

const root = createRoot(document.getElementById("root")!);
root.render(<PopupApp />);
