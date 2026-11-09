import { afterEach, describe, expect, test } from "bun:test";

import { downloadLeavesApp, imageFile, saveRoute, shareFile } from "./saveImage.ts";
import { nativeTransport, setTransport, type Transport } from "./transport.ts";

const saved = new Map(["navigator"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));

afterEach(() => {
  setTransport(nativeTransport);
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

function environment(navigator: Record<string, unknown>): void {
  Object.defineProperty(globalThis, "navigator", { value: navigator, configurable: true, writable: true });
}

describe("saveRoute", () => {
  test("is the share sheet where a link would leave the app", () => {
    environment({ standalone: true });
    expect(saveRoute()).toBe("share");
  });

  test("is the download link in a browser tab", () => {
    environment({ standalone: false });
    expect(saveRoute()).toBe("link");
    environment({});
    expect(saveRoute()).toBe("link");
  });
});

describe("downloadLeavesApp", () => {
  test("is true in a home-screen web app", () => {
    environment({ standalone: true });
    expect(downloadLeavesApp()).toBe(true);
  });

  test("is false in a browser tab", () => {
    environment({ standalone: false });
    expect(downloadLeavesApp()).toBe(false);
    environment({});
    expect(downloadLeavesApp()).toBe(false);
  });
});

describe("imageFile", () => {
  test("reads a PC's picture through the transport, keeping its image type", async () => {
    // Given a transport whose pictures the page shows from blob: URLs its CSP lets no fetch read
    const asked: string[] = [];
    const custom: Transport = { ...nativeTransport, kind: "custom", fetch: async (input) => {
      asked.push(String(input));
      return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
    } };
    setTransport(custom);
    // When the viewer reads the picture for the share sheet
    const file = await imageFile("/api/fs/file?path=%2Fshot.png", "shot.png", null);
    // Then it asked the transport for the PC's path, and the file is the picture under its name
    expect(asked).toEqual(["/api/fs/file?path=%2Fshot.png"]);
    expect([file.name, file.type, file.size]).toEqual(["shot.png", "image/png", 4]);
  });

  test("refuses a picture that is neither a PC path nor drawn", async () => {
    await expect(imageFile("data:image/png;base64,iVBORw0KGgo=", "inline.png", null)).rejects.toThrow("picture not shown");
  });
});

describe("shareFile", () => {
  const file = new File(["png"], "shot.png", { type: "image/png" });

  test("hands the file itself to the share sheet", async () => {
    const shared: ShareData[] = [];
    environment({ canShare: () => true, share: async (data: ShareData) => { shared.push(data); } });
    expect(await shareFile(file)).toBe("shared");
    expect(shared).toEqual([{ files: [file] }]);
  });

  test("a dismissed sheet is a cancel, not a failure", async () => {
    environment({ canShare: () => true, share: () => Promise.reject(new DOMException("dismissed", "AbortError")) });
    expect(await shareFile(file)).toBe("cancelled");
  });

  test("fails without a share sheet that takes files, or when it refuses", async () => {
    environment({});
    expect(await shareFile(file)).toBe("failed");
    environment({ canShare: () => false, share: async () => {} });
    expect(await shareFile(file)).toBe("failed");
    environment({ canShare: () => true, share: () => Promise.reject(new DOMException("no gesture", "NotAllowedError")) });
    expect(await shareFile(file)).toBe("failed");
  });
});
