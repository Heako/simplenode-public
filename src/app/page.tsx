"use client";

import dynamic from "next/dynamic";

// The app relies on Tauri APIs, so it never renders on the server.
const App = dynamic(() => import("@/components/App"), { ssr: false });

export default function Page() {
  return <App />;
}
