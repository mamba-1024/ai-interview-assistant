import { createRoot } from "react-dom/client";
import { PopupApp } from "./PopupApp";
import "./style.css";

const root = createRoot(document.getElementById("root")!);
root.render(<PopupApp />);
