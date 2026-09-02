// Wiederverwendbare Canvas-Signatur-Komponente (Maus + Touch/Pen).
// Speichert das Ergebnis erst beim Strichende (pointerup), nicht bei jedem
// pointermove, um Schreibgröße/-frequenz beim Autosave zu begrenzen.
//
// "savedDataUrl" ist die maßgebliche Quelle: jeder fertige Strich und jedes
// Laden eines Eintrags aktualisiert sie, und resize() zeichnet daraus neu.
// Dadurch geht eine Unterschrift nicht verloren, wenn ihr Canvas zum Lade-
// zeitpunkt noch unsichtbar (display:none -> 0x0) war und erst beim Tab-
// Wechsel sichtbar wird.
function createSignaturePad(canvas, onChange) {
  const ctx = canvas.getContext("2d");
  let drawing = false;
  let hasInk = false;
  let last = null;
  let savedDataUrl = "";
  let locked = false;

  function applyStyle() {
    const ratio = window.devicePixelRatio || 1;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#1e2330";
  }

  function redraw() {
    if (!savedDataUrl) return;
    const rect = canvas.getBoundingClientRect();
    const img = new Image();
    img.onload = () => ctx.drawImage(img, 0, 0, rect.width, rect.height);
    img.src = savedDataUrl;
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    // Unsichtbares Canvas (z.B. inaktiver Subtab) hat 0x0 -> nicht anfassen,
    // sonst würde das Backing-Bitmap auf 0 gesetzt und der Inhalt zerstört.
    if (rect.width === 0 || rect.height === 0) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = rect.width * ratio;
    canvas.height = rect.height * ratio;
    applyStyle();
    redraw();
  }

  function pointFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function start(e) {
    if (locked) return;
    e.preventDefault();
    drawing = true;
    last = pointFromEvent(e);
    canvas.setPointerCapture(e.pointerId);
  }

  function move(e) {
    if (!drawing) return;
    e.preventDefault();
    const p = pointFromEvent(e);
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last = p;
    hasInk = true;
  }

  function end(e) {
    if (!drawing) return;
    drawing = false;
    if (hasInk) {
      savedDataUrl = canvas.toDataURL("image/png");
      if (onChange) onChange(savedDataUrl);
    }
  }

  canvas.addEventListener("pointerdown", start);
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  canvas.addEventListener("pointerleave", (e) => { if (drawing) end(e); });

  window.addEventListener("resize", resize);
  resize();

  return {
    clear() {
      const rect = canvas.getBoundingClientRect();
      ctx.clearRect(0, 0, rect.width, rect.height);
      hasInk = false;
      savedDataUrl = "";
      if (onChange) onChange("");
    },
    // Leert die Anzeige beim Wechsel des Eintrags, ohne onChange auszulösen
    // (sonst würde das Laden eines anderen Eintrags die gerade verlassene Signatur löschen).
    resetSilent() {
      const rect = canvas.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) ctx.clearRect(0, 0, rect.width, rect.height);
      hasInk = false;
      savedDataUrl = "";
    },
    // Muss erneut aufgerufen werden, sobald das Canvas sichtbar wird: beim ersten
    // Erstellen (während die Detailansicht noch display:none ist) liefert
    // getBoundingClientRect() 0x0, wodurch das Canvas-Backing-Bitmap leer bleibt.
    resize,
    isEmpty() {
      return !hasInk;
    },
    toDataURL() {
      return hasInk ? canvas.toDataURL("image/png") : "";
    },
    setLocked(val) {
      locked = val;
    },
    loadDataURL(dataUrl) {
      // Nur echte Bild-DataURLs zeichnen. Eine manipulierte JSON-Datei könnte sonst
      // z.B. eine externe URL einschleusen, die beim Öffnen eines Eintrags geladen würde.
      if (!dataUrl || !/^data:image\//.test(dataUrl)) { savedDataUrl = ""; return; }
      savedDataUrl = dataUrl;
      hasInk = true;
      // Zeichnet sofort, falls sichtbar; sonst holt resize() beim Sichtbarwerden nach.
      redraw();
    }
  };
}
