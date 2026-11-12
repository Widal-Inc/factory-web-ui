// Browser QA only: synthetic branding/data, never a production entry or an authentication bypass.
import "../src/styles.css";
import { mountHub } from "../src/hub/mount.tsx";
const container = document.getElementById("root");
if (!container) throw new Error("Missing fixture root");
mountHub(container, { brand: { name: "Example app", logo: "/example.svg" } });
