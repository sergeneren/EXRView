import * as vscode from "vscode";

// Kept as a single file with no Node APIs so the same build runs in the
// desktop, remote and web extension hosts.

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(ExrEditorProvider.viewType, new ExrEditorProvider(context), {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    }),
  );
}

export function deactivate() {}

// Toolbar icons: 16px, drawn in currentColor so they follow the theme.
const svg = (body: string) =>
  `<svg class="glyph" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICONS = {
  // Square split into a light and a filled half, with +/- marks.
  exposure: svg(`<rect x="2" y="2" width="12" height="12" rx="1"/><path d="M14 2.6V13a1 1 0 0 1-1 1H2.6z" fill="currentColor" stroke="none"/><path d="M4 5.5h3M5.5 4v3"/>`),
  // Half-filled circle (contrast / blackpoint).
  offset: svg(`<circle cx="8" cy="8" r="6"/><path d="M8 2a6 6 0 0 0 0 12z" fill="currentColor" stroke="none"/>`),
  // Arrows stretching to the top and bottom bounds.
  normalize: svg(`<path d="M3 2.5h10M3 13.5h10M8 4.5v7M6 6.5l2-2 2 2M6 9.5l2 2 2-2"/>`),
  reset: svg(`<path d="M3.2 6.2A5 5 0 1 1 3 9"/><path d="M2.8 2.8v3.6h3.6"/>`),
  // Tone ramp.
  tonemap: svg(`<rect x="2" y="3" width="12" height="10" rx="1"/><rect x="2" y="3" width="3" height="10" fill="currentColor" stroke="none"/><rect x="5" y="3" width="3" height="10" fill="currentColor" fill-opacity=".6" stroke="none"/><rect x="8" y="3" width="3" height="10" fill="currentColor" fill-opacity=".3" stroke="none"/>`),
  // Axes with a gamma curve.
  gamma: svg(`<path d="M2.5 2v11.5H14"/><path d="M2.5 13.5C3.5 7 7 3.5 13.5 2.5"/><path d="M2.5 13.5L13.5 2.5" stroke-opacity=".35"/>`),
  grid: svg(`<rect x="2" y="2" width="12" height="12"/><path d="M6 2v12M10 2v12M2 6h12M2 10h12"/>`),
  values: svg(`<rect x="1.5" y="3" width="13" height="10" rx="1.5"/><path d="M4 6.2l1-.7v5M7.2 6.2c.4-.6 2.3-.8 2.3.6 0 1.3-2.3 2.2-2.3 3.7h2.4M11.2 5.7h1.9l-1.1 1.6c1 0 1.5.5 1.5 1.3 0 1.4-1.6 1.7-2.4.9" stroke-width="1"/>`),
  fit: svg(`<path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"/>`),
  info: svg(`<circle cx="8" cy="8" r="6"/><path d="M8 7.2v4"/><circle cx="8" cy="4.9" r=".4" fill="currentColor"/>`),
};

class ExrDocument implements vscode.CustomDocument {
  constructor(readonly uri: vscode.Uri) {}
  dispose() {}
}

class ExrEditorProvider implements vscode.CustomReadonlyEditorProvider<ExrDocument> {
  static readonly viewType = "exrview.viewer";

  constructor(private readonly context: vscode.ExtensionContext) {}

  openCustomDocument(uri: vscode.Uri): ExrDocument {
    return new ExrDocument(uri);
  }

  async resolveCustomEditor(document: ExrDocument, panel: vscode.WebviewPanel): Promise<void> {
    const media = vscode.Uri.joinPath(this.context.extensionUri, "media");
    panel.webview.options = { enableScripts: true, localResourceRoots: [media] };
    panel.webview.html = this.html(panel.webview, media);

    const sendFile = async (type: "load" | "reload") => {
      try {
        const bytes = await vscode.workspace.fs.readFile(document.uri);
        const name = document.uri.path.split("/").pop() ?? "";
        // readFile returns a Node Buffer, which postMessage does not
        // recognize as binary (it would JSON-encode every byte). Send an
        // exact-size ArrayBuffer, which is transferred as-is.
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        await panel.webview.postMessage({ type, name, buffer });
      } catch (e) {
        await panel.webview.postMessage({ type: "error", message: String(e) });
      }
    };

    // Renders often overwrite the file in place: reload, debounced because
    // writers touch the file several times while writing.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reload = () => {
      clearTimeout(timer);
      timer = setTimeout(() => sendFile("reload"), 300);
    };
    const dir = vscode.Uri.joinPath(document.uri, "..");
    const name = document.uri.path.split("/").pop() ?? "";
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, name));
    watcher.onDidChange(reload);
    watcher.onDidCreate(reload);

    const sub = panel.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === "ready") sendFile("load");
      else if (msg?.type === "status" && typeof msg.text === "string") vscode.window.setStatusBarMessage(msg.text, 3000);
    });
    panel.onDidDispose(() => {
      clearTimeout(timer);
      watcher.dispose();
      sub.dispose();
    });
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const uri = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(media, ...p)).toString();
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data: blob:`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}' ${webview.cspSource} 'wasm-unsafe-eval'`,
      `connect-src ${webview.cspSource}`,
      // The decoder runs in a worker built from a blob (see media/decoder.js).
      "worker-src blob:",
    ].join("; ");
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${uri("viewer.css")}">
  <title>EXRView</title>
</head>
<body>
  <div id="toolbar">
    <span class="group">
      <label class="field">Layer <select id="layer"></select></label>
      <label class="field">Channel <select id="channel"></select></label>
    </span>
    <span class="group" data-tip="Exposure" data-key="E / Shift+E" data-desc="Multiply the pixel values by 2^exposure before display. Drag to adjust (Shift for fine control), scroll to step, double-click to type a value.">
      ${ICONS.exposure}<div id="exposure" class="slider"></div>
    </span>
    <span class="group" data-tip="Blackpoint offset" data-desc="Add this offset to the pixel values after exposure. Drag to adjust (Shift for fine control), scroll to step, double-click to type a value.">
      ${ICONS.offset}<div id="offset" class="slider"></div>
    </span>
    <span class="group">
      <button id="normalize" class="icon" data-tip="Normalize exposure" data-key="N" data-desc="Adjust the exposure and blackpoint offset to fit the displayed values to the range [0, 1].">${ICONS.normalize}</button>
      <button id="reset" class="icon" data-tip="Reset tonemapping" data-key="R" data-desc="Reset the exposure and blackpoint offset to 0 and the gamma to 1.">${ICONS.reset}</button>
    </span>
    <span class="group" data-tip="Tonemapping mode" data-desc="Applied to the pixel values after exposure and blackpoint offset.\n\nGamma: raise the values to 1/gamma, then apply the sRGB transfer curve (gamma 1 is a plain sRGB display).\nColormap [0,1]: false color with the colormap range set to [0, 1].\nColormap [−1,1]: false color with the colormap range set to [−1, +1] (a diverging colormap like IceFire shows positive/negative values).">
      ${ICONS.tonemap}<select id="tonemap">
        <option value="gamma">Gamma</option>
        <option value="cmap01">Colormap [0,1]</option>
        <option value="cmap11">Colormap [−1,1]</option>
      </select>
      <select id="colormap"></select><span id="swatch"></span>
    </span>
    <span class="group" id="gammaGroup" data-tip="Gamma" data-key="G / Shift+G" data-desc="Raise the pixel values to 1/gamma before the sRGB transfer curve (Gamma mode only).">
      ${ICONS.gamma}<div id="gamma" class="slider"></div>
    </span>
    <span class="group">
      <button id="grid" class="icon toggle" data-tip="Draw pixel grid" data-desc="Outline each pixel when zoomed in far enough.">${ICONS.grid}</button>
      <button id="values" class="icon toggle" data-tip="Draw pixel values" data-desc="Print each pixel's channel values on the image when zoomed in far enough for them to fit.">${ICONS.values}</button>
    </span>
    <span class="spacer"></span>
    <span class="group">
      <button id="fit" class="icon" data-tip="Fit to window" data-key="F">${ICONS.fit}</button>
      <button id="oneToOne" class="icon text" data-tip="Actual size (100%)" data-key="1">1:1</button>
      <button id="info" class="icon toggle" data-tip="Header attributes" data-key="I" data-desc="Show the header attributes and channels of the selected layer's part.">${ICONS.info}</button>
    </span>
  </div>
  <div id="main">
    <div id="viewport"><canvas id="canvas"></canvas><canvas id="overlay"></canvas><div id="message"></div></div>
    <div id="panel" hidden></div>
  </div>
  <div id="tooltip" hidden></div>
  <div id="statusbar"><span id="pixel"></span><span class="spacer"></span><span id="progress"></span><span id="summary"></span></div>
  <script nonce="${nonce}">window.EXRVIEW_URLS = ${JSON.stringify({
    glue: uri("wasm", "exrview.js"),
    core: uri("decoder-core.js"),
    wasm: uri("wasm", "exrview.wasm"),
  })};</script>
  <script nonce="${nonce}" type="module" src="${uri("viewer.js")}"></script>
</body>
</html>`;
  }
}
